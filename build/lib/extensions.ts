/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as es from 'event-stream';
import * as fs from 'fs';
import * as glob from 'glob';
import * as gulp from 'gulp';
import * as path from 'path';
import { Stream } from 'stream';
import * as File from 'vinyl';
import * as vsce from 'vsce';
import { createStatsStream } from './stats';
import * as util2 from './util';
import remote = require('gulp-remote-src');
const vzip = require('gulp-vinyl-zip');
import filter = require('gulp-filter');
import rename = require('gulp-rename');
import * as fancyLog from 'fancy-log';
import * as ansiColors from 'ansi-colors';
const buffer = require('gulp-buffer');
import json = require('gulp-json-editor');
const webpack = require('webpack');
const webpackGulp = require('webpack-stream');

const root = path.resolve(path.join(__dirname, '..', '..'));

// {{SQL CARBON EDIT}}
import * as _ from 'underscore';
import * as vfs from 'vinyl-fs';
const deps = require('../dependencies');
const extensionsRoot = path.join(root, 'extensions');
const extensionsProductionDependencies = deps.getProductionDependencies(extensionsRoot);

export function packageBuiltInExtensions() {
	const sqlBuiltInLocalExtensionDescriptions = glob.sync('extensions/*/package.json')
		.map(manifestPath => {
			const extensionPath = path.dirname(path.join(root, manifestPath));
			const extensionName = path.basename(extensionPath);
			return { name: extensionName, path: extensionPath };
		})
		.filter(({ name }) => excludedExtensions.indexOf(name) === -1)
		.filter(({ name }) => builtInExtensions.every(b => b.name !== name))
		.filter(({ name }) => sqlBuiltInExtensions.indexOf(name) >= 0);
	const visxDirectory = path.join(path.dirname(root), 'vsix');
	try {
		if (!fs.existsSync(visxDirectory)) {
			fs.mkdirSync(visxDirectory);
		}
	} catch (err) {
		// don't fail the build if the output directory already exists
		console.warn(err);
	}
	sqlBuiltInLocalExtensionDescriptions.forEach(element => {
		let pkgJson = JSON.parse(fs.readFileSync(path.join(element.path, 'package.json'), { encoding: 'utf8' }));
		const packagePath = path.join(visxDirectory, `${pkgJson.name}-${pkgJson.version}.vsix`);
		console.info('Creating vsix for ' + element.path + ' result:' + packagePath);
		vsce.createVSIX({
			cwd: element.path,
			packagePath: packagePath,
			useYarn: true
		});
	});
}

export function packageExtensionTask(extensionName: string, platform: string, arch: string) {
	var destination = path.join(path.dirname(root), 'azuredatastudio') + (platform ? '-' + platform : '') + (arch ? '-' + arch : '');
	if (platform === 'darwin') {
		destination = path.join(destination, 'Azure Data Studio.app', 'Contents', 'Resources', 'app', 'extensions', extensionName);
	} else {
		destination = path.join(destination, 'resources', 'app', 'extensions', extensionName);
	}

	platform = platform || process.platform;

	return () => {
		const root = path.resolve(path.join(__dirname, '../..'));
		const localExtensionDescriptions = glob.sync('extensions/*/package.json')
			.map(manifestPath => {
				const extensionPath = path.dirname(path.join(root, manifestPath));
				const extensionName = path.basename(extensionPath);
				return { name: extensionName, path: extensionPath };
			})
			.filter(({ name }) => extensionName === name);

		const localExtensions = es.merge(...localExtensionDescriptions.map(extension => {
			return fromLocal(extension.path);
		}));

		let result = localExtensions
			.pipe(util2.skipDirectories())
			.pipe(util2.fixWin32DirectoryPermissions())
			.pipe(filter(['**', '!LICENSE', '!LICENSES.chromium.html', '!version']));

		return result.pipe(vfs.dest(destination));
	};
}
// {{SQL CARBON EDIT}} - End

function fromLocal(extensionPath: string, sourceMappingURLBase?: string): Stream {
	const webpackFilename = path.join(extensionPath, 'extension.webpack.config.js');
	if (fs.existsSync(webpackFilename)) {
		return fromLocalWebpack(extensionPath, sourceMappingURLBase);
	} else {
		return fromLocalNormal(extensionPath);
	}
}

function fromLocalWebpack(extensionPath: string, sourceMappingURLBase: string | undefined): Stream {
	const result = es.through();

	const packagedDependencies: string[] = [];
	const packageJsonConfig = require(path.join(extensionPath, 'package.json'));
	if (packageJsonConfig.dependencies) {
		const webpackRootConfig = require(path.join(extensionPath, 'extension.webpack.config.js'));
		for (const key in webpackRootConfig.externals) {
			if (key in packageJsonConfig.dependencies) {
				packagedDependencies.push(key);
			}
		}
	}

	vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Yarn, packagedDependencies }).then(fileNames => {
		const files = fileNames
			.map(fileName => path.join(extensionPath, fileName))
			.map(filePath => new File({
				path: filePath,
				stat: fs.statSync(filePath),
				base: extensionPath,
				contents: fs.createReadStream(filePath) as any
			}));

		const filesStream = es.readArray(files);

		// check for a webpack configuration files, then invoke webpack
		// and merge its output with the files stream. also rewrite the package.json
		// file to a new entry point
		const webpackConfigLocations = (<string[]>glob.sync(
			path.join(extensionPath, '/**/extension.webpack.config.js'),
			{ ignore: ['**/node_modules'] }
		));

		const packageJsonFilter = filter(f => {
			if (path.basename(f.path) === 'package.json') {
				// only modify package.json's next to the webpack file.
				// to be safe, use existsSync instead of path comparison.
				return fs.existsSync(path.join(path.dirname(f.path), 'extension.webpack.config.js'));
			}
			return false;
		}, { restore: true });

		const patchFilesStream = filesStream
			.pipe(packageJsonFilter)
			.pipe(buffer())
			.pipe(json((data: any) => {
				if (data.main) {
					// hardcoded entry point directory!
					data.main = data.main.replace('/out/', /dist/);
				}
				return data;
			}))
			.pipe(packageJsonFilter.restore);


		const webpackStreams = webpackConfigLocations.map(webpackConfigPath => () => {

			const webpackDone = (err: any, stats: any) => {
				fancyLog(`Bundled extension: ${ansiColors.yellow(path.join(path.basename(extensionPath), path.relative(extensionPath, webpackConfigPath)))}...`);
				if (err) {
					result.emit('error', err);
				}
				const { compilation } = stats;
				if (compilation.errors.length > 0) {
					result.emit('error', compilation.errors.join('\n'));
				}
				if (compilation.warnings.length > 0) {
					result.emit('error', compilation.warnings.join('\n'));
				}
			};

			const webpackConfig = {
				...require(webpackConfigPath),
				...{ mode: 'production' }
			};
			const relativeOutputPath = path.relative(extensionPath, webpackConfig.output.path);

			return webpackGulp(webpackConfig, webpack, webpackDone)
				.pipe(es.through(function (data) {
					data.stat = data.stat || {};
					data.base = extensionPath;
					this.emit('data', data);
				}))
				.pipe(es.through(function (data: File) {
					// source map handling:
					// * rewrite sourceMappingURL
					// * save to disk so that upload-task picks this up
					if (sourceMappingURLBase) {
						const contents = (<Buffer>data.contents).toString('utf8');
						data.contents = Buffer.from(contents.replace(/\n\/\/# sourceMappingURL=(.*)$/gm, function (_m, g1) {
							return `\n//# sourceMappingURL=${sourceMappingURLBase}/extensions/${path.basename(extensionPath)}/${relativeOutputPath}/${g1}`;
						}), 'utf8');

						if (/\.js\.map$/.test(data.path)) {
							if (!fs.existsSync(path.dirname(data.path))) {
								fs.mkdirSync(path.dirname(data.path));
							}
							fs.writeFileSync(data.path, data.contents);
						}
					}
					this.emit('data', data);
				}));
		});

		es.merge(sequence(webpackStreams), patchFilesStream)
			// .pipe(es.through(function (data) {
			// 	// debug
			// 	console.log('out', data.path, data.contents.length);
			// 	this.emit('data', data);
			// }))
			.pipe(result);

	}).catch(err => {
		console.error(extensionPath);
		console.error(packagedDependencies);
		result.emit('error', err);
	});

	return result.pipe(createStatsStream(path.basename(extensionPath)));
}

function fromLocalNormal(extensionPath: string): Stream {
	const result = es.through();

	vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Yarn })
		.then(fileNames => {
			const files = fileNames
				.map(fileName => path.join(extensionPath, fileName))
				.map(filePath => new File({
					path: filePath,
					stat: fs.statSync(filePath),
					base: extensionPath,
					contents: fs.createReadStream(filePath) as any
				}));

			es.readArray(files).pipe(result);
		})
		.catch(err => result.emit('error', err));

	return result.pipe(createStatsStream(path.basename(extensionPath)));
}

const baseHeaders = {
	'X-Market-Client-Id': 'VSCode Build',
	'User-Agent': 'VSCode Build',
	'X-Market-User-Id': '291C1CD0-051A-4123-9B4B-30D60EF52EE2',
};

export function fromMarketplace(extensionName: string, version: string, metadata: any): Stream {
	const [publisher, name] = extensionName.split('.');
	const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`;

	fancyLog('Downloading extension:', ansiColors.yellow(`${extensionName}@${version}`), '...');

	const options = {
		base: url,
		requestOptions: {
			gzip: true,
			headers: baseHeaders
		}
	};

	const packageJsonFilter = filter('package.json', { restore: true });

	return remote('', options)
		.pipe(vzip.src())
		.pipe(filter('extension/**'))
		.pipe(rename(p => p.dirname = p.dirname!.replace(/^extension\/?/, '')))
		.pipe(packageJsonFilter)
		.pipe(buffer())
		.pipe(json({ __metadata: metadata }))
		.pipe(packageJsonFilter.restore);
}

interface IPackageExtensionsOptions {
	/**
	 * Set to undefined to package all of them.
	 */
	desiredExtensions?: string[];
	sourceMappingURLBase?: string;
}

const excludedExtensions = [
	'vscode-api-tests',
	'vscode-colorize-tests',
	'vscode-test-resolver',
	'ms-vscode.node-debug',
	'ms-vscode.node-debug2',
	// {{SQL CARBON EDIT}}
	'integration-tests'
];

// {{SQL CARBON EDIT}}
const sqlBuiltInExtensions = [
	// Add SQL built-in extensions here.
	// the extension will be excluded from SQLOps package and will have separate vsix packages
	'admin-tool-ext-win',
	'agent',
	'import',
	'profiler',
	'admin-pack',
	'big-data-cluster',
	'dacpac',
	'schema-compare',
	'resource-deployment',
	'cms'
];
// {{SQL CARBON EDIT}} - End

interface IBuiltInExtension {
	name: string;
	version: string;
	repo: string;
	metadata: any;
}

const builtInExtensions: IBuiltInExtension[] = require('../builtInExtensions.json');

/**
 * We're doing way too much stuff at once, with webpack et al. So much stuff
 * that while downloading extensions from the marketplace, node js doesn't get enough
 * stack frames to complete the download in under 2 minutes, at which point the
 * marketplace server cuts off the http request. So, we sequentialize the extensino tasks.
 */
function sequence(streamProviders: { (): Stream }[]): Stream {
	const result = es.through();

	function pop() {
		if (streamProviders.length === 0) {
			result.emit('end');
		} else {
			const fn = streamProviders.shift()!;
			fn()
				.on('end', function () { setTimeout(pop, 0); })
				.pipe(result, { end: false });
		}
	}

	pop();
	return result;
}

export function packageExtensionsStream(optsIn?: IPackageExtensionsOptions): NodeJS.ReadWriteStream {
	const opts = optsIn || {};

	const localExtensionDescriptions = (<string[]>glob.sync('extensions/*/package.json'))
		.map(manifestPath => {
			const extensionPath = path.dirname(path.join(root, manifestPath));
			const extensionName = path.basename(extensionPath);
			return { name: extensionName, path: extensionPath };
		})
		.filter(({ name }) => excludedExtensions.indexOf(name) === -1)
		.filter(({ name }) => opts.desiredExtensions ? opts.desiredExtensions.indexOf(name) >= 0 : true)
		.filter(({ name }) => builtInExtensions.every(b => b.name !== name))
		// {{SQL CARBON EDIT}}
		.filter(({ name }) => sqlBuiltInExtensions.indexOf(name) === -1);

	const localExtensions = () => sequence([...localExtensionDescriptions.map(extension => () => {
		return fromLocal(extension.path, opts.sourceMappingURLBase)
			.pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
	})]);

	// {{SQL CARBON EDIT}}
	const extensionDepsSrc = [
		..._.flatten(extensionsProductionDependencies.map((d: any) => path.relative(root, d.path)).map((d: any) => [`${d}/**`, `!${d}/**/{test,tests}/**`])),
	];

	const localExtensionDependencies = () => gulp.src(extensionDepsSrc, { base: '.', dot: true })
		.pipe(filter(['**', '!**/package-lock.json']));

	// Original code commented out here
	// const localExtensionDependencies = () => gulp.src('extensions/node_modules/**', { base: '.' });

	// const marketplaceExtensions = () => es.merge(
	// 	...builtInExtensions
	// 		.filter(({ name }) => opts.desiredExtensions ? opts.desiredExtensions.indexOf(name) >= 0 : true)
	// 		.map(extension => {
	// 			return fromMarketplace(extension.name, extension.version, extension.metadata)
	// 				.pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
	// 		})
	// );

	return sequence([localExtensions, localExtensionDependencies, /*marketplaceExtensions*/])
		.pipe(util2.setExecutableBit(['**/*.sh']))
		.pipe(filter(['**', '!**/*.js.map']));
	// {{SQL CARBON EDIT}} - End
}
