/**
 * CI-friendly report serializers: JUnit XML and SARIF.
 *
 * Pure functions over the TestReport model (type-only imports, no vscode),
 * so they can be unit tested in plain Node and reused anywhere.
 */
import type {
    TestReport,
    CategoryReport,
    TestResultDetail,
    SecurityFinding,
    TestStatus
} from '../types';

/* ------------------------------ JUnit XML ------------------------------ */

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function seconds(ms?: number): string {
    return ((ms ?? 0) / 1000).toFixed(3);
}

type JUnitOutcome = 'passed' | 'failed' | 'skipped';

function toJUnitOutcome(status: TestStatus | undefined): JUnitOutcome {
    switch (status) {
        case 'passed':
        case 'manual_pass':
            return 'passed';
        case 'failed':
        case 'manual_fail':
            return 'failed';
        default:
            // pending, running, skipped, not_tested
            return 'skipped';
    }
}

function testcaseToXml(detail: TestResultDetail): string {
    const { test, result } = detail;
    const outcome = toJUnitOutcome(result?.status);
    const attrs =
        `name="${escapeXml(test.name)}" ` +
        `classname="${escapeXml(`TestFox.${test.category}`)}" ` +
        `time="${seconds(result?.duration)}"`;

    if (outcome === 'passed') {
        return `      <testcase ${attrs}/>`;
    }
    if (outcome === 'skipped') {
        const reason = result?.status ? ` message="${escapeXml(`status: ${result.status}`)}"` : '';
        return `      <testcase ${attrs}>\n        <skipped${reason}/>\n      </testcase>`;
    }
    const message = escapeXml(result?.error || 'Test failed');
    const body = result?.logs?.length ? escapeXml(result.logs.join('\n')) : '';
    return `      <testcase ${attrs}>\n        <failure message="${message}">${body}</failure>\n      </testcase>`;
}

/** Serialize a TestReport as JUnit XML (one testsuite per category). */
export function toJUnitXml(report: TestReport): string {
    const suites: string[] = [];

    for (const category of report.categories) {
        const failures = category.tests.filter(t => toJUnitOutcome(t.result?.status) === 'failed').length;
        const skipped = category.tests.filter(t => toJUnitOutcome(t.result?.status) === 'skipped').length;
        const time = seconds(category.tests.reduce((sum, t) => sum + (t.result?.duration ?? 0), 0));
        const cases = category.tests.map(testcaseToXml).join('\n');
        suites.push(
            `    <testsuite name="${escapeXml(`TestFox ${category.category}`)}" ` +
            `tests="${category.tests.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n` +
            `${cases}\n    </testsuite>`
        );
    }

    const totalFailures = report.summary.failed + report.summary.manualFailed;
    const totalSkipped = report.summary.skipped + report.summary.notTested;

    return `<?xml version="1.0" encoding="UTF-8"?>
  <testsuites name="TestFox" tests="${report.summary.totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${seconds(report.summary.duration)}">
${suites.join('\n')}
  </testsuites>
`;
}

/* -------------------------------- SARIF -------------------------------- */

type SarifLevel = 'error' | 'warning' | 'note';

function toSarifLevel(severity: SecurityFinding['severity']): SarifLevel {
    switch (severity) {
        case 'critical':
        case 'high':
            return 'error';
        case 'medium':
            return 'warning';
        default:
            return 'note';
    }
}

interface SarifRule {
    id: string;
    name: string;
    shortDescription: { text: string };
    defaultConfiguration: { level: SarifLevel };
}

interface SarifResult {
    ruleId: string;
    level: SarifLevel;
    message: { text: string };
    locations: Array<{
        physicalLocation: {
            artifactLocation: { uri: string };
        };
    }>;
}

/**
 * Serialize a TestReport as SARIF 2.1.0: security findings become results
 * keyed by their security test type, and failed tests become
 * `testfox/test-failure` results so CI code scanning can surface them.
 */
export function toSarif(report: TestReport, toolVersion = 'unknown'): string {
    const rules = new Map<string, SarifRule>();
    const results: SarifResult[] = [];

    const addRule = (rule: SarifRule) => {
        if (!rules.has(rule.id)) {
            rules.set(rule.id, rule);
        }
    };

    for (const finding of report.securityFindings) {
        const level = toSarifLevel(finding.severity);
        const ruleId = `testfox/security-${finding.type}`;
        addRule({
            id: ruleId,
            name: `Security/${finding.type}`,
            shortDescription: { text: `TestFox security finding (${finding.type})` },
            defaultConfiguration: { level }
        });
        results.push({
            ruleId,
            level,
            message: { text: `${finding.severity.toUpperCase()}: ${finding.description}` },
            locations: [{
                physicalLocation: {
                    artifactLocation: { uri: finding.location || 'workspace' }
                }
            }]
        });
    }

    const failedTests = report.categories.flatMap((category: CategoryReport) =>
        category.tests.filter(t => toJUnitOutcome(t.result?.status) === 'failed')
    );
    if (failedTests.length > 0) {
        addRule({
            id: 'testfox/test-failure',
            name: 'TestFailure',
            shortDescription: { text: 'A TestFox test case failed' },
            defaultConfiguration: { level: 'error' }
        });
        for (const detail of failedTests) {
            results.push({
                ruleId: 'testfox/test-failure',
                level: 'error',
                message: {
                    text: `Test failed: ${detail.test.name}${detail.result?.error ? ` - ${detail.result.error}` : ''}`
                },
                locations: [{
                    physicalLocation: {
                        artifactLocation: { uri: detail.test.targetElement?.path || 'workspace' }
                    }
                }]
            });
        }
    }

    const sarif = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
            tool: {
                driver: {
                    name: 'TestFox',
                    version: toolVersion,
                    informationUri: 'https://github.com/senthazalravi/TestFox',
                    rules: [...rules.values()]
                }
            },
            results
        }]
    };

    return JSON.stringify(sarif, null, 2);
}
