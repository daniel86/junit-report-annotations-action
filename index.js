const core = require('@actions/core');
const github = require('@actions/github');
const glob = require('@actions/glob');
const fs = require('fs');
var parseString = require('xml2js').parseStringPromise;

(async () => {
    try {
        const path = core.getInput('path');
        const stripFromPath = core.getInput('stripFromPath');
        const accessToken = core.getInput('accessToken');
        
        const globber = await glob.create(path, {followSymbolicLinks: false});
        let annotations = [];
        
        let numTests = 0;
        let numSkipped = 0;
        let numFailed = 0;
        let numErrored = 0;
        let testDuration = 0;

        for await (const file of globber.globGenerator()) {
            const data = await fs.promises.readFile(file);
            var json = await parseString(data);
        
            if (json.testsuites === undefined) {
                continue;
            }

            for (let row of json.testsuites.testsuite) {
                if (row.testcase !== undefined) {
                    row.testsuite = [row];
                }

                for (let testsuite of row.testsuite) {
                    testDuration += Number(testsuite['$']['time']);
                    numTests += Number(testsuite['$']['tests']);
                    numErrored += Number(testsuite['$']['errors']);
                    numFailed += Number(testsuite['$']['failures']);
                    //numSkipped += Number(testsuite['$']['skipped']);
                    
                    if (testsuite['$']['errors'] !== '0' || testsuite['$']['failures'] !== '0') {
                        for (let testCase of testsuite.testcase) {
                            if (testCase.failure) {
                                let file = testCase['$'].file;
                                let line = testCase['$'].line || '1';

                                if (stripFromPath) {
                                    file = file.replace(stripFromPath, '')
                                }

                                if (line === '0') {
                                    line = '1';
                                }


                                annotations.push({
                                    path: file,
                                    start_line: line,
                                    end_line: line,
                                    start_column: 0,
                                    end_column: 0,
                                    annotation_level: 'failure',
                                    title: testsuite['$'].name + "::" + testCase['$'].name,
                                    message: testCase.failure[0]['_'],
                                });
                            }
                        }
                    }
                }
            }
            
            const annotation_level = numFailed + numErrored > 0 ? "failure" : "notice";
            const summary_annotation = {
                path: "test",
                start_line: 0,
                end_line: 0,
                start_column: 0,
                end_column: 0,
                annotation_level,
                title: 'Test summary',
                message: `Junit Results ran ${numTests} in ${testDuration} seconds ${numErrored} Errored, ${numFailed} Failed, ${numSkipped} Skipped`,
            };
            annotations = [summary_annotation, ...annotations];
            console.log(annotations);
            
            if (annotation_level === "failure") {
                //can just log these
                for (const annotation of annotations) {
                    console.info(
                        `::warning title=${annotation.title},file=${annotation.path},line=${annotation.start_line}::${annotation.message}`
                    );
                }
            } else {
                const octokit = new github.GitHub(accessToken);
                const req = {
                    ...github.context.repo,
                    ref: github.context.sha
                }
                const res = await octokit.checks.listForRef(req);
                const jobName = process.env.GITHUB_JOB;

                const checkRun = res.data.check_runs.find(
                  (check) => check.name === jobName
                );
                if (!checkRun) {
                  console.log(
                    "Junit tests result passed but can not identify test suite."
                  );
                  console.log(
                    "Can happen when performing a pull request from a forked repository."
                  );
                  return;
                }
                const check_run_id = checkRun.id;

                const update_req = {
                    ...github.context.repo,
                    check_run_id,
                    output: {
                        title: "Junit Results",
                        summary: `jUnit Results`,
                        annotations: annotations
                    }
                }
                await octokit.checks.update(update_req);
            }
        }
    } catch(error) {
        core.setFailed(error.message);
    }
})();
