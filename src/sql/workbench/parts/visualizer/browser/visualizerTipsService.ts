import { localize } from 'vs/nls';
import { join } from 'vs/base/common/path';
import { forEach } from 'vs/base/common/collections';
import { IDisposable, dispose, Disposable } from 'vs/base/common/lifecycle';
import { match } from 'vs/base/common/glob';
import * as json from 'vs/base/common/json';
import {
	IExtensionManagementService, IExtensionGalleryService, IExtensionTipsService, ExtensionRecommendationReason, EXTENSION_IDENTIFIER_PATTERN,
	IExtensionsConfigContent, RecommendationChangeNotification, IExtensionRecommendation, ExtensionRecommendationSource, InstallOperation
} from 'vs/platform/extensionManagement/common/extensionManagement';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ITextModel } from 'vs/editor/common/model';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import product from 'vs/platform/product/node/product';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ShowRecommendedExtensionsAction, InstallWorkspaceRecommendedExtensionsAction, InstallRecommendedExtensionAction } from 'vs/workbench/contrib/extensions/electron-browser/extensionsActions';
import Severity from 'vs/base/common/severity';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspace, IWorkspaceFoldersChangeEvent, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IFileService } from 'vs/platform/files/common/files';
// {{SQL CARBON EDIT}}
import { IExtensionsConfiguration, ConfigurationKey, ShowRecommendationsOnlyOnDemandKey, IExtensionsViewlet, IExtensionsWorkbenchService, EXTENSIONS_CONFIG, ExtensionsPolicyKey, ExtensionsPolicy } from 'vs/workbench/contrib/extensions/common/extensions';
import { IConfigurationService, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import * as pfs from 'vs/base/node/pfs';
import * as os from 'os';
import { flatten, distinct, shuffle, coalesce } from 'vs/base/common/arrays';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { guessMimeTypes, MIME_UNKNOWN } from 'vs/base/common/mime';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { getHashedRemotesFromUri } from 'vs/workbench/contrib/stats/node/workspaceStats';
import { IRequestService } from 'vs/platform/request/node/request';
import { asJson } from 'vs/base/node/request';
import { isNumber } from 'vs/base/common/types';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { Emitter, Event } from 'vs/base/common/event';
import { assign } from 'vs/base/common/objects';
import { URI } from 'vs/base/common/uri';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IExperimentService, ExperimentActionType, ExperimentState } from 'vs/workbench/contrib/experiments/node/experimentService';
import { CancellationToken } from 'vs/base/common/cancellation';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { extname } from 'vs/base/common/resources';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';

// import { DownloadSandDance } from 'sql/workbench/parts/visualizer/browser/downloadSandDance.ts';

const SESSION_COUNT_KEY = 'nps/sessionCount';
const LAST_SESSION_DATE_KEY = 'nps/lastSessionDate';

function caseInsensitiveGet<T>(obj: { [key: string]: T }, key: string): T | undefined {
	if (!obj) {
		return undefined;
	}
	for (const _key in obj) {
		if (Object.hasOwnProperty.call(obj, _key) && _key.toLowerCase() === key.toLowerCase()) {
			return obj[_key];
		}
	}
	return undefined;
}

export class VisualizerTipsService extends Disposable implements IExtensionTipsService {

	_serviceBrand: any;

	private _fileBasedRecommendations: { [id: string]: { recommendedTime: number, sources: ExtensionRecommendationSource[] }; } = Object.create(null);
	// {{SQL CARBON EDIT}}
	private _recommendations: string[] = [];
	private _exeBasedRecommendations: { [id: string]: string; } = Object.create(null);
	private _availableRecommendations: { [pattern: string]: string[] } = Object.create(null);
	private _allWorkspaceRecommendedExtensions: IExtensionRecommendation[] = [];
	private _dynamicWorkspaceRecommendations: string[] = [];
	private _experimentalRecommendations: { [id: string]: string } = Object.create(null);
	private _allIgnoredRecommendations: string[] = [];
	private _globallyIgnoredRecommendations: string[] = [];
	private _workspaceIgnoredRecommendations: string[] = [];
	private _extensionsRecommendationsUrl: string;
	private _disposables: IDisposable[] = [];
	public loadWorkspaceConfigPromise: Promise<void>;
	private proactiveRecommendationsFetched: boolean = false;
	private readonly _onRecommendationChange = new Emitter<RecommendationChangeNotification>();
	onRecommendationChange: Event<RecommendationChangeNotification> = this._onRecommendationChange.event;
	private sessionSeed: number;
	notificationService: INotificationService;
//	storageService: IStorageService;



	constructor(
		@INotificationService notificationService: INotificationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,

		@IExtensionGalleryService private readonly _galleryService: IExtensionGalleryService,
		@IModelService private readonly _modelService: IModelService,
		@IStorageService private readonly storageService: IStorageService,
		@IExtensionManagementService private readonly extensionsService: IExtensionManagementService,
	//	@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	//	@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IRequestService private readonly requestService: IRequestService,
		@IViewletService private readonly viewletService: IViewletService,
	//	@INotificationService private readonly notificationService: INotificationService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionsWorkbenchService private readonly extensionWorkbenchService: IExtensionsWorkbenchService,
		@IExperimentService private readonly experimentService: IExperimentService,
		@ITextFileService private readonly textFileService: ITextFileService

	) {
		super();
		this.notificationService = notificationService;
	//	this.storageService = storageService;
	}

	/*
	onVisualizerClick
	onRunQuery
	onFileType = csv
	private onWorkspaceFoldersChanged(event: IWorkspaceFoldersChangeEvent): void {
	*/

	/**
	 * Prompt the user to install visualizer recommendations if there are any not already installed
	 */
	private promptVisualizerRecommendations(): void {
		/*
		// nps.contribution.ts
		const date = new Date().toDateString();
		const lastSessionDate = storageService.get(LAST_SESSION_DATE_KEY, StorageScope.GLOBAL, new Date(0).toDateString());

		if (date === lastSessionDate) {
			return;
		}

		const sessionCount = (storageService.getNumber(SESSION_COUNT_KEY, StorageScope.GLOBAL, 0) || 0) + 1;
		storageService.store(LAST_SESSION_DATE_KEY, date, StorageScope.GLOBAL);
		storageService.store(SESSION_COUNT_KEY, sessionCount, StorageScope.GLOBAL);

		if (sessionCount < 9) {
			return;
		}
		*/
		/*
		const storageKey = 'extensionsAssistant/workspaceRecommendationsIgnore';
		const config = this.configurationService.getValue<IExtensionsConfiguration>(ConfigurationKey);
		const filteredRecs = this._allWorkspaceRecommendedExtensions;//.filter(rec => this.isExtensionAllowedToBeRecommended(rec.extensionId));

		if (filteredRecs.length === 0
			|| config.ignoreRecommendations
			|| config.showRecommendationsOnlyOnDemand){
		//	|| this.storageService.getBoolean(storageKey, StorageScope.WORKSPACE, false)) {

			return;
		}
	*/
		const filteredRecs = this._allWorkspaceRecommendedExtensions;
		this.extensionsService.getInstalled(ExtensionType.User).then(local => {
			const recommendations = filteredRecs.filter(({ extensionId }) => local.every(local => !areSameExtensions({ id: extensionId }, local.identifier)));

			if (!recommendations.length) {
				return Promise.resolve(undefined);
			}

			return new Promise<void>(c => {
				this.notificationService.prompt(
					Severity.Info,
					localize('downloadSandDance.notice', "The SandDance extension is required to use this feature. Would you like to download the SandDance extension?"),
					[{
						label: localize('downloadSandDanceNotice.yes', "Download"),
						run: () => {
							//telemetryService.publicLog('extensionWorkspaceRecommendations:popup', { userReaction: 'install' });
							const installAllAction = this.instantiationService.createInstance(InstallWorkspaceRecommendedExtensionsAction, InstallWorkspaceRecommendedExtensionsAction.ID, localize('installAll', "Install All"), recommendations);
							installAllAction.run();
							installAllAction.dispose();
							c(undefined);
						}
					}, {
						label: localize('downloadSandDanceNotice.never', "Don't ask again"), //label: choiceNever,
						isSecondary: true,
						run: () => {
							// this.telemetryService.publicLog('extensionWorkspaceRecommendations:popup', { userReaction: 'neverShowAgain' });
							// this.storageService.store(storageKey, true, StorageScope.WORKSPACE);
							c(undefined);
						}
					}],
					{
						sticky: true,
						onCancel: () => {
							// this.telemetryService.publicLog('extensionWorkspaceRecommendations:popup', { userReaction: 'cancelled' });
							c(undefined);
						}
					}
				);
			});
		});
	}



	getAllRecommendationsWithReason(): { [id: string]: { reasonId: ExtensionRecommendationReason, reasonText: string }; } {
		let output: { [id: string]: { reasonId: ExtensionRecommendationReason, reasonText: string }; } = Object.create(null);

		// if (!this.proactiveRecommendationsFetched) {
		// 	return output;
		// }

		// forEach(this._experimentalRecommendations, entry => output[entry.key.toLowerCase()] = {
		// 	reasonId: ExtensionRecommendationReason.Experimental,
		// 	reasonText: entry.value
		// });

		// if (this.contextService.getWorkspace().folders && this.contextService.getWorkspace().folders.length === 1) {
		// 	const currentRepo = this.contextService.getWorkspace().folders[0].name;

		// 	this._dynamicWorkspaceRecommendations.forEach(id => output[id.toLowerCase()] = {
		// 		reasonId: ExtensionRecommendationReason.DynamicWorkspace,
		// 		reasonText: localize('dynamicWorkspaceRecommendation', "This extension may interest you because it's popular among users of the {0} repository.", currentRepo)
		// 	});
		// }

		// forEach(this._exeBasedRecommendations, entry => output[entry.key.toLowerCase()] = {
		// 	reasonId: ExtensionRecommendationReason.Executable,
		// 	reasonText: localize('exeBasedRecommendation', "This extension is recommended because you have {0} installed.", entry.value)
		// });

		// forEach(this._fileBasedRecommendations, entry => output[entry.key.toLowerCase()] = {
		// 	reasonId: ExtensionRecommendationReason.File,
		// 	reasonText: localize('fileBasedRecommendation', "This extension is recommended based on the files you recently opened.")
		// });


		// this._allWorkspaceRecommendedExtensions.forEach(({ extensionId }) => output[extensionId.toLowerCase()] = {
		// 	reasonId: ExtensionRecommendationReason.Workspace,
		// 	reasonText: localize('workspaceRecommendation', "This extension is recommended by users of the current workspace.")
		// });

		// // {{SQL CARBON EDIT}}
		// this._recommendations.forEach(x => output[x.toLowerCase()] = {
		// 	reasonId: ExtensionRecommendationReason.Executable,
		// 	reasonText: localize('defaultRecommendations', "This extension is recommended by Azure Data Studio.")
		// });

		// for (const id of this._allIgnoredRecommendations) {
		// 	delete output[id];
		// }

		return output;
	}


	getAllIgnoredRecommendations(): { global: string[], workspace: string[] } {
		return {
			global: this._globallyIgnoredRecommendations,
			workspace: this._workspaceIgnoredRecommendations
		};
	}

	toggleIgnoredRecommendation(extensionId: string, shouldIgnore: boolean) {
		const lowerId = extensionId.toLowerCase();
		if (shouldIgnore) {
			const reason = this.getAllRecommendationsWithReason()[lowerId];
			if (reason && reason.reasonId) {
			//	this.telemetryService.publicLog('extensionsRecommendations:ignoreRecommendation', { id: extensionId, recommendationReason: reason.reasonId });
			}
		}

		this._globallyIgnoredRecommendations = shouldIgnore ?
			distinct([...this._globallyIgnoredRecommendations, lowerId].map(id => id.toLowerCase())) :
			this._globallyIgnoredRecommendations.filter(id => id !== lowerId);

		this.storageService.store('extensionsAssistant/ignored_recommendations', JSON.stringify(this._globallyIgnoredRecommendations), StorageScope.GLOBAL);
		this._allIgnoredRecommendations = distinct([...this._globallyIgnoredRecommendations, ...this._workspaceIgnoredRecommendations]);

		this._onRecommendationChange.fire({ extensionId: extensionId, isRecommended: !shouldIgnore });
	}

	getKeymapRecommendations(): IExtensionRecommendation[] {
		return (product.keymapExtensionTips || [])
			.filter(extensionId => this.isExtensionAllowedToBeRecommended(extensionId))
			.map(extensionId => (<IExtensionRecommendation>{ extensionId, sources: ['application'] }));
	}

	getWorkspaceRecommendations(): Promise<IExtensionRecommendation[]> {
		if (!this.isEnabled()) { return Promise.resolve([]); }
		// return this.fetchWorkspaceRecommendations()
		// 	.then(() => this._allWorkspaceRecommendedExtensions.filter(rec => this.isExtensionAllowedToBeRecommended(rec.extensionId)));
	}


	getFileBasedRecommendations(): IExtensionRecommendation[] {
		return Object.keys(this._fileBasedRecommendations)
			.sort((a, b) => {
				if (this._fileBasedRecommendations[a].recommendedTime === this._fileBasedRecommendations[b].recommendedTime) {
					if (!product.extensionImportantTips || caseInsensitiveGet(product.extensionImportantTips, a)) {
						return -1;
					}
					if (caseInsensitiveGet(product.extensionImportantTips, b)) {
						return 1;
					}
				}
				return this._fileBasedRecommendations[a].recommendedTime > this._fileBasedRecommendations[b].recommendedTime ? -1 : 1;
			})
			.filter(extensionId => this.isExtensionAllowedToBeRecommended(extensionId))
			.map(extensionId => (<IExtensionRecommendation>{ extensionId, sources: this._fileBasedRecommendations[extensionId].sources }));
	}


	getOtherRecommendations(): Promise<IExtensionRecommendation[]> {
		// {{SQL CARBON EDIT}} - Replace body of this method with our own
		let recommendations = Object.keys(this._exeBasedRecommendations).concat(this._recommendations);
		shuffle(recommendations, this.sessionSeed);
		return Promise.resolve(recommendations.map(extensionId => {
			const sources: ExtensionRecommendationSource[] = [];
			if (this._exeBasedRecommendations[extensionId]) {
				sources.push('executable');
			}
			if (this._dynamicWorkspaceRecommendations.indexOf(extensionId) !== -1) {
				sources.push('dynamic');
			}
			return (<IExtensionRecommendation>{ extensionId, sources });
		}));
		// {{SQL CARBON EDIT}} - End
	}

	private isEnabled(): boolean {
		return this._galleryService.isEnabled() && !this.environmentService.extensionDevelopmentLocationURI;
	}

	private isExtensionAllowedToBeRecommended(id: string): boolean {
		return this._allIgnoredRecommendations.indexOf(id.toLowerCase()) === -1;
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}

}