import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeSensitive, scanSensitive } from "../src/sensitive.ts";

const labels = (source: string) => scanSensitive(source).findings.map((f) => f.label);

describe("secrets", () => {
  test("well-known token shapes are secrets, masked in the report", () => {
    const key = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const report = scanSensitive(`OPENAI_API_KEY=${key}\n`);
    assert.equal(report.level, "secret");
    assert.deepEqual(labels(`OPENAI_API_KEY=${key}`), ["an OpenAI API key"]);
    assert.equal(report.findings[0]!.sample, "sk-p…N4");
    assert.ok(!JSON.stringify(report).includes(key));
    assert.deepEqual(labels("aws_access_key_id = AKIAIOSFODNN7REALKEY"), ["an AWS access key"]);
    assert.deepEqual(labels("token: ghp_" + "A".repeat(36)), ["a GitHub token"]);
    assert.deepEqual(labels("x-api-key: sk-ant-api03-" + "Zz9".repeat(10)), ["an Anthropic API key"]);
    assert.deepEqual(labels("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----"), ["a private key"]);
    assert.deepEqual(labels("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), ["a JSON Web Token"]);
  });

  test("passwords in settings and URLs are secrets", () => {
    assert.deepEqual(labels('{"db_password": "hunter2hunter2"}'), ["a password or key in a setting"]);
    assert.deepEqual(labels("DATABASE_URL=postgres://app:s3cr3tpass@db.internal:5432/app"), ["a password in a URL"]);
    assert.equal(scanSensitive("CLIENT_SECRET=Qx7mPz2Lw9").findings[0]!.line, 1);
    assert.equal(scanSensitive("a\nb\nAPI_KEY=Qx7mPz2Lw9vR").findings[0]!.line, 3);
  });

  test("placeholders, references and code that only mentions a secret are not secrets", () => {
    for (const source of [
      "OPENAI_API_KEY=your-api-key-here",
      "API_KEY=${API_KEY}",
      "password: <your password>",
      "TOKEN=xxxxxxxxxxxx",
      "const token = secret();",
      "store.run('DELETE FROM pastes WHERE tokenHash=?', checksum(token))",
      '"stored API key": "false"',
      "postgres://user:password@localhost/db",
      "postgres://user:${PGPASSWORD}@localhost/db",
      "token_count=12345678",
    ])
      assert.equal(scanSensitive(source).level, null, source);
  });
});

describe("personal details", () => {
  test("emails, public IPs and named home directories are personal, not secret", () => {
    const report = scanSensitive("from jane.doe@acme.io at 203.1.113.9\ncwd /home/jane/src\n");
    assert.equal(report.level, "personal");
    assert.deepEqual(report.findings.map((f) => f.sample), ["jane.doe@acme.io", "203.1.113.9", "jane"]);
  });

  test("examples, private networks and generic accounts are left alone", () => {
    for (const source of [
      "mail me@example.com or noreply@github.com",
      "listen 127.0.0.1 and 192.168.1.20, 10.0.0.5, 172.20.0.1, docs 198.51.100.7",
      "version 1.2.3, released 2026.10.17",
      "cd /home/runner/work && ls /Users/username/",
    ])
      assert.equal(scanSensitive(source).level, null, source);
  });

  test("a codex doctor report names the account but holds no secret", () => {
    const doctor = JSON.stringify({
      "auth env vars present": "OPENAI_API_KEY",
      "stored API key": "false",
      "stored ChatGPT tokens": "true",
      "auth file": "/home/anthony/.codex/auth.json",
      endpoint: "wss://chatgpt.com/backend-api/<redacted>",
      SSH_CLIENT: "present",
      generatedAt: "1790070861s since unix epoch",
    }, null, 2);
    const report = scanSensitive(doctor);
    assert.equal(report.level, "personal");
    assert.deepEqual(describeSensitive(report), ["personal: a home directory with your account name on line 5: anthony"]);
  });
});
