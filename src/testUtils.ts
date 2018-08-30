/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

import cp = require('child_process');
import path = require('path');
import vscode = require('vscode');
import util = require('util');
import { parseEnvFile, getCurrentGoWorkspaceFromGOPATH } from './goPath';
import { getToolsEnvVars, getGoVersion, LineBuffer, SemVersion, resolvePath, getCurrentGoPath, getBinPath } from './util';
import { GoDocumentSymbolProvider } from './goOutline';
import { getNonVendorPackages } from './goPackages';

const sendSignal = 'SIGKILL';
const outputChannel = vscode.window.createOutputChannel('Go Tests');
const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
statusBarItem.command = 'go.test.cancel';
statusBarItem.text = '$(x) Cancel Running Tests';

/**
 *  testProcesses holds a list of currently running test processes.
 */
const runningTestProcesses: cp.ChildProcess[] = [];

const testSuiteMethodRegex = /^\(([^)]+)\)\.(Test.*)$/;

/**
 * Input to goTest.
 */
export interface TestConfig {
	/**
	 * The working directory for `go test`.
	 */
	dir: string;
	/**
	 * Configuration for the Go extension
	 */
	goConfig: vscode.WorkspaceConfiguration;
	/**
	 * Test flags to override the testFlags and buildFlags from goConfig.
	 */
	flags: string[];
	/**
	 * Specific function names to test.
	 */
	functions?: string[];
	/**
	 * Test was not requested explicitly. The output should not appear in the UI.
	 */
	background?: boolean;
	/**
	 * Run all tests from all sub directories under `dir`
	 */
	includeSubDirectories?: boolean;
	/**
	 * Whether this is a benchmark.
	 */
	isBenchmark?: boolean;
}

export function getTestEnvVars(config: vscode.WorkspaceConfiguration): any {
	const envVars = getToolsEnvVars();
	const testEnvConfig = config['testEnvVars'] || {};

	let fileEnv = {};
	let testEnvFile = config['testEnvFile'];
	if (testEnvFile) {
		testEnvFile = resolvePath(testEnvFile);
		try {
			fileEnv = parseEnvFile(testEnvFile);
		} catch (e) {
			console.log(e);
		}
	}

	Object.keys(testEnvConfig).forEach(key => envVars[key] = typeof testEnvConfig[key] === 'string' ? resolvePath(testEnvConfig[key]) : testEnvConfig[key]);
	Object.keys(fileEnv).forEach(key => envVars[key] = typeof fileEnv[key] === 'string' ? resolvePath(fileEnv[key]) : fileEnv[key]);

	return envVars;
}

export function getTestFlags(goConfig: vscode.WorkspaceConfiguration, args: any): string[] {
	let testFlags: string[] = goConfig['testFlags'] ? goConfig['testFlags'] : goConfig['buildFlags'];
	testFlags = testFlags.map(x => resolvePath(x)); // Use copy of the flags, dont pass the actual object from config
	return (args && args.hasOwnProperty('flags') && Array.isArray(args['flags'])) ? args['flags'] : testFlags;
}

/**
 * Returns all Go unit test functions in the given source file.
 *
 * @param the URI of a Go source file.
 * @return test function symbols for the source file.
 */
export function getTestFunctions(doc: vscode.TextDocument, token: vscode.CancellationToken): Thenable<vscode.SymbolInformation[]> {
	let documentSymbolProvider = new GoDocumentSymbolProvider();
	return documentSymbolProvider
		.provideDocumentSymbols(doc, token)
		.then(symbols =>
			symbols.filter(sym =>
				sym.kind === vscode.SymbolKind.Function
				&& (sym.name.startsWith('Test') || sym.name.startsWith('Example') || testSuiteMethodRegex.test(sym.name))
			)
		);
}

/**
 * Extracts test method name of a suite test function.
 * For example a symbol with name "(*testSuite).TestMethod" will return "TestMethod".
 *
 * @param symbolName Symbol Name to extract method name from.
 */
export function extractInstanceTestName(symbolName: string): string {
	const match = symbolName.match(testSuiteMethodRegex);
	if (!match || match.length !== 3) {
		return null;
	}
	return match[2];
}

/**
 * Finds test methods containing "suite.Run()" call.
 *
 * @param doc Editor document
 * @param allTests All test functions
 */
export function findAllTestSuiteRuns(doc: vscode.TextDocument, allTests: vscode.SymbolInformation[]): vscode.SymbolInformation[] {
	// get non-instance test functions
	const testFunctions = allTests.filter(t => !testSuiteMethodRegex.test(t.name));
	// filter further to ones containing suite.Run()
	return testFunctions.filter(t => doc.getText(t.location.range).includes('suite.Run('));
}

/**
 * Returns all Benchmark functions in the given source file.
 *
 * @param the URI of a Go source file.
 * @return benchmark function symbols for the source file.
 */
export function getBenchmarkFunctions(doc: vscode.TextDocument, token: vscode.CancellationToken): Thenable<vscode.SymbolInformation[]> {
	let documentSymbolProvider = new GoDocumentSymbolProvider();
	return documentSymbolProvider
		.provideDocumentSymbols(doc, token)
		.then(symbols =>
			symbols.filter(sym =>
				sym.kind === vscode.SymbolKind.Function
				&& sym.name.startsWith('Benchmark'))
		);
}

/**
 * Runs go test and presents the output in the 'Go' channel.
 *
 * @param goConfig Configuration for the Go extension.
 */
export function goTest(testconfig: TestConfig): Thenable<boolean> {
	return new Promise<boolean>((resolve, reject) => {

		// We do not want to clear it if tests are already running, as that could
		// lose valuable output.
		if (runningTestProcesses.length < 1) {
			outputChannel.clear();
		}

		if (!testconfig.background) {
			outputChannel.show(true);
		}

		let buildTags: string = testconfig.goConfig['buildTags'];
		let args: Array<string> = ['test', ...testconfig.flags];
		let testType: string = testconfig.isBenchmark ? 'Benchmarks' : 'Tests';

		if (testconfig.isBenchmark) {
			args.push('-benchmem', '-run=^$');
		} else {
			args.push('-timeout', testconfig.goConfig['testTimeout']);
		}
		if (buildTags && testconfig.flags.indexOf('-tags') === -1) {
			args.push('-tags', buildTags);
		}

		let testEnvVars = getTestEnvVars(testconfig.goConfig);
		let goRuntimePath = getBinPath('go');

		if (!goRuntimePath) {
			vscode.window.showInformationMessage('Cannot find "go" binary. Update PATH or GOROOT appropriately');
			return Promise.resolve();
		}

		// Append the package name to args to enable running tests in symlinked directories
		let currentGoWorkspace = getCurrentGoWorkspaceFromGOPATH(getCurrentGoPath(), testconfig.dir);
		if (currentGoWorkspace && !testconfig.includeSubDirectories) {
			args.push(testconfig.dir.substr(currentGoWorkspace.length + 1));
		}

		targetArgs(testconfig).then(targets => {
			let outTargets = args.slice(0);
			if (targets.length > 4) {
				outTargets.push('<long arguments omitted>');
			} else {
				outTargets.push(...targets);
			}
			outputChannel.appendLine(['Running tool:', goRuntimePath, ...outTargets].join(' '));
			outputChannel.appendLine('');

			args.push(...targets);

			let tp = cp.spawn(goRuntimePath, args, { env: testEnvVars, cwd: testconfig.dir });
			const outBuf = new LineBuffer();
			const errBuf = new LineBuffer();

			const packageResultLineRE = /^(ok|FAIL)[ \t]+(.+?)[ \t]+([0-9\.]+s|\(cached\))/; // 1=ok/FAIL, 2=package, 3=time/(cached)
			const testResultLines: string[] = [];

			const processTestResultLine = (line: string) => {
				testResultLines.push(line);
				const result = line.match(packageResultLineRE);
				if (result && currentGoWorkspace) {
					const packageNameArr = result[2].split('/');
					const baseDir = path.join(currentGoWorkspace, ...packageNameArr);
					testResultLines.forEach(line => outputChannel.appendLine(expandFilePathInOutput(line, baseDir)));
					testResultLines.splice(0);
				}
			};

			// go test emits test results on stdout, which contain file names relative to the package under test
			outBuf.onLine(line => processTestResultLine(line));
			outBuf.onDone(last => {
				if (last) processTestResultLine(last);

				// If there are any remaining test result lines, emit them to the output channel.
				if (testResultLines.length > 0) {
					testResultLines.forEach(line => outputChannel.appendLine(line));
				}
			});

			// go test emits build errors on stderr, which contain paths relative to the cwd
			errBuf.onLine(line => outputChannel.appendLine(expandFilePathInOutput(line, testconfig.dir)));
			errBuf.onDone(last => last && outputChannel.appendLine(expandFilePathInOutput(last, testconfig.dir)));

			tp.stdout.on('data', chunk => outBuf.append(chunk.toString()));
			tp.stderr.on('data', chunk => errBuf.append(chunk.toString()));

			statusBarItem.show();

			tp.on('close', (code, signal) => {
				outBuf.done();
				errBuf.done();

				if (code) {
					outputChannel.appendLine(`Error: ${testType} failed.`);
				} else if (signal === sendSignal) {
					outputChannel.appendLine(`Error: ${testType} terminated by user.`);
				} else {
					outputChannel.appendLine(`Success: ${testType} passed.`);
				}

				let index = runningTestProcesses.indexOf(tp, 0);
				if (index > -1) {
					runningTestProcesses.splice(index, 1);
				}

				if (!runningTestProcesses.length) {
					statusBarItem.hide();
				}

				resolve(code === 0);
			});

			runningTestProcesses.push(tp);

		}, err => {
			outputChannel.appendLine(`Error: ${testType} failed.`);
			outputChannel.appendLine(err);
			resolve(false);
		});
	});
}

/**
 * Reveals the output channel in the UI.
 */
export function showTestOutput() {
	outputChannel.show(true);
}

/**
 * Iterates the list of currently running test processes and kills them all.
 */
export function cancelRunningTests(): Thenable<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		runningTestProcesses.forEach(tp => {
			tp.kill(sendSignal);
		});
		// All processes are now dead. Empty the array to prepare for the next run.
		runningTestProcesses.splice(0, runningTestProcesses.length);
		resolve(true);
	});
}

function expandFilePathInOutput(output: string, cwd: string): string {
	let lines = output.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let matches = lines[i].match(/^\s*(.+.go):(\d+):/);
		if (matches && matches[1] && !path.isAbsolute(matches[1])) {
			lines[i] = lines[i].replace(matches[1], path.join(cwd, matches[1]));
		}
	}
	return lines.join('\n');
}

/**
 * Get the test target arguments.
 *
 * @param testconfig Configuration for the Go extension.
 */
function targetArgs(testconfig: TestConfig): Thenable<Array<string>> {
	if (testconfig.functions) {
		let params: string[] = [];
		if (testconfig.isBenchmark) {
			params = ['-bench', util.format('^%s$', testconfig.functions.join('|'))];
		} else {
			let testFunctions = testconfig.functions;
			let testifyMethods = testFunctions.filter(fn => testSuiteMethodRegex.test(fn));
			if (testifyMethods.length > 0) {
				// filter out testify methods
				testFunctions = testFunctions.filter(fn => !testSuiteMethodRegex.test(fn));
				testifyMethods = testifyMethods.map(extractInstanceTestName);
			}

			// we might skip the '-run' param when running only testify methods, which will result
			// in running all the test methods, but one of them should call testify's `suite.Run(...)`
			// which will result in the correct thing to happen
			if (testFunctions.length > 0) {
				params = params.concat(['-run', util.format('^%s$', testFunctions.join('|'))]);
			}
			if (testifyMethods.length > 0) {
				params = params.concat(['-testify.m', util.format('^%s$', testifyMethods.join('|'))]);
			}
		}
		return Promise.resolve(params);
	}
	let params: string[] = [];
	if (testconfig.isBenchmark) {
		params = ['-bench', '.'];
	} else if (testconfig.includeSubDirectories) {
		return getGoVersion().then((ver: SemVersion) => {
			if (ver && (ver.major > 1 || (ver.major === 1 && ver.minor >= 9))) {
				return ['./...'];
			}
			return getNonVendorPackages(testconfig.dir);
		});
	}
	return Promise.resolve(params);
}
