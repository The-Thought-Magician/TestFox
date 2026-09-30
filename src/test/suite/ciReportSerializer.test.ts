import * as assert from 'assert';
import { toJUnitXml, toSarif } from '../../reports/ciReportSerializer';
import type { TestReport } from '../../types';

function sampleReport(): TestReport {
    return {
        generatedAt: new Date('2026-09-30T00:00:00Z'),
        summary: {
            totalTests: 3,
            passed: 1,
            failed: 1,
            skipped: 0,
            notTested: 1,
            manualPassed: 0,
            manualFailed: 0,
            passRate: 33,
            duration: 2500
        },
        categories: [{
            category: 'functional',
            total: 3,
            passed: 1,
            failed: 1,
            skipped: 1,
            tests: [
                {
                    test: {
                        id: 't1', name: 'Login works', description: '', category: 'functional',
                        automationLevel: 'full', priority: 'high', tags: [], steps: [],
                        expectedResult: 'ok'
                    },
                    result: { testId: 't1', status: 'passed', duration: 1000, timestamp: new Date() }
                },
                {
                    test: {
                        id: 't2', name: 'Rejects bad <password> & "quotes"', description: '', category: 'functional',
                        automationLevel: 'full', priority: 'critical', tags: [], steps: [],
                        expectedResult: 'error shown',
                        targetElement: { type: 'route', path: '/login' }
                    },
                    result: { testId: 't2', status: 'failed', duration: 1500, error: 'Expected 401, got 500', timestamp: new Date() }
                },
                {
                    test: {
                        id: 't3', name: 'Pending test', description: '', category: 'functional',
                        automationLevel: 'manual', priority: 'low', tags: [], steps: [],
                        expectedResult: ''
                    },
                    result: { testId: 't3', status: 'pending', timestamp: new Date() }
                }
            ]
        }],
        securityFindings: [{
            severity: 'high',
            type: 'xss',
            title: 'Reflected XSS',
            description: 'Search box reflects input',
            location: '/search',
            recommendation: 'Escape output'
        }],
        performanceMetrics: { averageResponseTime: 0, maxResponseTime: 0, minResponseTime: 0, p95ResponseTime: 0, p99ResponseTime: 0, throughput: 0, errorRate: 0, endpoints: [] },
        recommendations: []
    };
}

suite('ciReportSerializer', () => {

    test('JUnit XML is well-formed with correct totals and escaping', () => {
        const xml = toJUnitXml(sampleReport());

        assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(xml.includes('tests="3" failures="1"'));
        assert.ok(xml.includes('<testsuite name="TestFox functional" tests="3" failures="1" skipped="1"'));
        assert.ok(xml.includes('name="Login works" classname="TestFox.functional" time="1.000"/>'));
        // XML-unsafe characters in test names and messages must be escaped
        assert.ok(xml.includes('Rejects bad &lt;password&gt; &amp; &quot;quotes&quot;'));
        assert.ok(xml.includes('<failure message="Expected 401, got 500">'));
        assert.ok(xml.includes('<skipped message="status: pending"/>'));
    });

    test('JUnit XML maps manual outcomes sensibly', () => {
        const report = sampleReport();
        report.categories[0].tests[1].result.status = 'manual_fail';
        report.categories[0].tests[2].result.status = 'manual_pass';
        const xml = toJUnitXml(report);
        assert.ok(xml.includes('failures="1"'), 'manual_fail counts as failure');
        assert.ok(!xml.includes('<skipped message="status: manual_pass"/>'), 'manual_pass is a pass');
    });

    test('SARIF is valid 2.1.0 with security findings and failed tests', () => {
        const sarif = JSON.parse(toSarif(sampleReport(), '8.3.2'));

        assert.strictEqual(sarif.version, '2.1.0');
        assert.strictEqual(sarif.runs[0].tool.driver.name, 'TestFox');
        assert.strictEqual(sarif.runs[0].tool.driver.version, '8.3.2');

        const ruleIds = sarif.runs[0].tool.driver.rules.map((r: any) => r.id);
        assert.ok(ruleIds.includes('testfox/security-xss'));
        assert.ok(ruleIds.includes('testfox/test-failure'));

        const results = sarif.runs[0].results;
        assert.strictEqual(results.length, 2);

        const finding = results.find((r: any) => r.ruleId === 'testfox/security-xss');
        assert.strictEqual(finding.level, 'error', 'high severity maps to error');
        assert.strictEqual(finding.locations[0].physicalLocation.artifactLocation.uri, '/search');

        const failure = results.find((r: any) => r.ruleId === 'testfox/test-failure');
        assert.ok(failure.message.text.includes('Rejects bad'));
        assert.strictEqual(failure.locations[0].physicalLocation.artifactLocation.uri, '/login');
    });

    test('SARIF severity mapping: medium -> warning, low/info -> note', () => {
        const report = sampleReport();
        report.securityFindings = [
            { severity: 'medium', type: 'csrf', title: 't', description: 'd', recommendation: 'r' },
            { severity: 'info', type: 'security_headers', title: 't', description: 'd', recommendation: 'r' }
        ];
        report.categories[0].tests = report.categories[0].tests.filter(t => t.result.status !== 'failed');
        const sarif = JSON.parse(toSarif(report));
        const levels = sarif.runs[0].results.map((r: any) => r.level);
        assert.deepStrictEqual(levels, ['warning', 'note']);
    });

    test('SARIF handles a report with no findings and no failures', () => {
        const report = sampleReport();
        report.securityFindings = [];
        report.categories[0].tests = report.categories[0].tests.filter(t => t.result.status !== 'failed');
        const sarif = JSON.parse(toSarif(report));
        assert.deepStrictEqual(sarif.runs[0].results, []);
        assert.deepStrictEqual(sarif.runs[0].tool.driver.rules, []);
    });
});
