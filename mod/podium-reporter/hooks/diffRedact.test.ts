import { describe, test, expect } from 'claude-code/testing'
import { redactDiff, redactText, withheldPath } from './diffRedact.ts'

const one = (line: string) => redactDiff(line)

describe('redactDiff: shapes that are secrets', () => {
  const secrets: [string, string, string][] = [
    ['an Anthropic key', '+  key: "sk-ant-api03-abcdefghijklmnopqrstuv"', 'sk-ant-'],
    ['an OpenAI key', '+OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-proj'],
    ['a GitHub token', ' const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'ghp_'],
    ['a GitHub OAuth token', '-gho_abcdefghijklmnopqrstuvwxyz0123456789ab', 'gho_'],
    ['a fine-grained GitHub token', '+github_pat_11ABCDEFG0abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop', 'github_pat_'],
    ['a GitLab token', '+glpat-abcdefghijklmnopqrst', 'glpat-'],
    ['an AWS access key id', '+aws_key = AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['an AWS temporary key id', '+AS' + 'IAIOSFODNN7EXAMPLE', 'AS' + 'IAIOSFODNN7EXAMPLE'],
    ['an AWS secret after its name', '+aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['a Google key', '+  "key": "AI' + 'zaSyA1234567890abcdefghijklmnopqrstuv"', 'AI' + 'zaSy'],
    ['a Slack token', '+SLACK=xo' + 'xb-123456789012-abcdefghijklmnop', 'xoxb-'],
    ['a Stripe live key', '+sk_' + 'live_abcdefghijklmnopqrstuvwx', 'sk_live_'],
    ['a Stripe webhook secret', '+whs' + 'ec_abcdefghijklmnopqrstuvwxyz012345', 'whs' + 'ec_'],
    ['an npm token', '+//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abc'],
    ['a SendGrid key', '+SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789abcdefg', 'SG.abc'],
    ['an Azure storage key', '+DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab==', 'AccountKey=abc'],
    ['a JWT', '+const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"', 'eyJhbGci'],
    ['a bearer credential', '+  Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'abcdefghijkl'],
    ['a basic credential', '+curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="', 'dXNlcjpw'],
    ['a cookie header', '+Cookie: session=abc123def456; theme=dark', 'abc123def456'],
    ['an x-api-key header', '+  "x-api-key": "k_1234567890abcdef"', 'k_1234567890'],
    ['a password in a URL', '+DATABASE_URL=postgres://app:s3cr3tpass@db.internal:5432/app', 's3cr3tpass'],
    ['a password in an https URL', '+git clone https://user:ghs_notreallyatoken@github.com/x/y', 'notreally'],
    ['an env password', '+DB_PASSWORD=hunter2', 'hunter2'],
    ['a quoted password', '+  password: "correct horse battery"', 'correct horse'],
    ['a JSON secret', '+  "client_secret": "abc123XYZ"', 'abc123XYZ'],
    ['a yaml token', '+api_key: abcdef123456', 'abcdef123456'],
    ['an api key in code', "+const apiKey = 'abcd1234efgh5678'", 'abcd1234efgh5678'],
    ['a camelCase key', '+  accessKey: "abcd1234"', 'abcd1234'],
    ['a dashed key', '+auth-token = "abcd1234"', 'abcd1234'],
    ['a salt', '+SALT=9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['a command line password', '+mysql -u root --password hunter2 db', 'hunter2'],
    ['a command line password flag', '+curl --token=abcdef123456 https://x', 'abcdef123456'],
    ['a mysql -p password', '+mysql -u root -phunter2 db', 'hunter2'],
    ['a random 32 character value', '+const seed = "q7Zk2LmX9pRt4VbN8cYd1HsW5eAg3JfU"', 'q7Zk2LmX9pRt4VbN8cYd1HsW5eAg3JfU'],
  ]
  for (const [name, line, leak] of secrets) {
    test(name, () => {
      const r = one(line)
      expect(r.text.includes(leak)).toBe(false)
      expect(r.text.includes('[redacted]')).toBe(true)
      expect(r.redactions >= 1).toBe(true)
      expect(r.text[0]).toBe(line[0])
    })
  }

  test('keeps the key and the line around the value', () => {
    const r = one('+  password: "hunter2hunter2"')
    expect(r.text).toBe('+  password: "[redacted]"')
    expect(one('+DB_PASSWORD=hunter2').text).toBe('+DB_PASSWORD=[redacted]')
    expect(one('+postgres://app:s3cr3t@db/app').text).toBe('+postgres://app:[redacted]@db/app')
  })

  test('removed lines are redacted too', () => {
    const r = one('-  apiKey: "abcd1234efgh5678"')
    expect(r.text).toBe('-  apiKey: "[redacted]"')
  })

  test('counts every value', () => {
    const r = one('+a=1 password=hunter2 token=abcdef123456 AKIAIOSFODNN7EXAMPLE')
    expect(r.redactions).toBe(3)
  })

  test('a private key block is redacted over every line and keeps the line count', () => {
    const text = ['+-----BEGIN RSA PRIVATE KEY-----', '+MIIEowIBAAKCAQEAabcdefghijklmnop', '+qrstuvwxyz0123456789ABCDEFGHIJKL', '+-----END RSA PRIVATE KEY-----', ' after'].join('\n')
    const r = redactDiff(text)
    const lines = r.text.split('\n')
    expect(lines.length).toBe(5)
    expect(r.text.includes('MIIEow')).toBe(false)
    expect(r.text.includes('qrstuvwxyz')).toBe(false)
    expect(lines[4]).toBe(' after')
    expect(r.redactions).toBe(1)
  })

  test('a private key block with escaped newlines on one line', () => {
    const r = one('+"key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----\\n"')
    expect(r.text.includes('MIIEvQ')).toBe(false)
  })

  test('a key block cut off in one hunk does not blank the next hunk', () => {
    const r = redactDiff('@@ -1 +1 @@\n+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBgkq\n@@ -40 +40 @@\n const visible = 1\n+const next = 2')
    expect(r.text.includes('MIIEvQ')).toBe(false)
    expect(r.text.includes(' const visible = 1')).toBe(true)
    expect(r.text.includes('+const next = 2')).toBe(true)
  })

  test('a block is closed at the end of the diff even without an END line', () => {
    const r = redactDiff('+-----BEGIN OPENSSH PRIVATE KEY-----\n+b3BlbnNzaC1rZXktdjEAAAAA')
    expect(r.text.includes('b3Bl')).toBe(false)
  })
})

describe('redactDiff: lines that must not change', () => {
  const clean: [string, string][] = [
    ['a token read from a call', '+  const token = getToken()'],
    ['a type annotation', '+  password: string'],
    ['an optional type annotation', '+  token?: string | null'],
    ['a reference to the environment', '+  apiKey: process.env.API_KEY,'],
    ['an environment variable reference', '+PASSWORD=${DB_PASSWORD}'],
    ['a shell variable', '+export TOKEN=$TOKEN'],
    ['a boolean', '+  auth: true'],
    ['an empty value', '+  password: ""'],
    ['a function name', '+function tokenize(input: string) {'],
    ['a comment about a token', '+// the token is read from the environment'],
    ['a header built from a variable', '+  headers: { Authorization: `Bearer ${token}` },'],
    ['a git sha', ' commit 7eb90e8d3f1a2b4c5d6e7f8091a2b3c4d5e6f708'],
    ['a sha-256', '+"hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"'],
    ['a uuid', '+id: 550e8400-e29b-41d4-a716-446655440000'],
    ['a long identifier', '+  const veryLongLineThatKeepsGoing = buildSomethingElseWithManyWords(first, second)'],
    ['a long import path', '+import { thing } from "../../components/some/very/long/path/to/the/module/index"'],
    ['an absolute path', '+  cwd: "/Users/someone/dev/claude-dashboard/.claude/worktrees/issue-319"'],
    ['a lock file integrity hash', '+      "integrity": "sha512-q7Zk2LmX9pRt4VbN8cYd1HsW5eAg3JfUq7Zk2LmX9pRt4VbN8cYd1HsW5eAg3JfU==",'],
    ['plain prose', '+Run the server and open the console in a browser.'],
    ['a version', '+  "version": "1.12.3-beta.4+build.20260101"'],
    ['a diff context line', ' export function routes(deps: Deps) {'],
  ]
  for (const [name, line] of clean) {
    test(name, () => {
      const r = one(line)
      expect(r.text).toBe(line)
      expect(r.redactions).toBe(0)
    })
  }
})

describe('redactDiff: shape', () => {
  test('is idempotent', () => {
    const once = one('+DB_PASSWORD=hunter2')
    expect(one(once.text).text).toBe(once.text)
    expect(one(once.text).redactions).toBe(0)
  })
  test('keeps line breaks, carriage returns and the line prefixes', () => {
    const r = redactDiff(' a\n-b password=hunter2\n+c\n')
    expect(r.text).toBe(' a\n-b password=[redacted]\n+c\n')
  })
  test('does not change a hunk header or a file header', () => {
    expect(one('@@ -1,3 +1,4 @@ function password(token) {').text).toBe('@@ -1,3 +1,4 @@ function password(token) {')
  })
})

describe('withheldPath', () => {
  const withheld = ['.env', '.env.local', 'apps/web/.env.production', 'cert.pem', 'a/b/server.key', 'store.p12', 'x.pfx', 'id_rsa', 'home/.ssh/id_ed25519', 'id_rsa.pub.bak', '.npmrc', 'sub/.netrc', 'credentials', 'aws/credentials.json']
  for (const p of withheld) test(`withholds ${p}`, () => expect(withheldPath(p)).toBe(true))
  const shown = ['src/environment.ts', 'docs/env.md', 'keyboard.ts', 'monkey.ts', 'README.md', 'src/pemfile.ts', 'my.envelope']
  for (const p of shown) test(`shows ${p}`, () => expect(withheldPath(p)).toBe(false))
})

describe('redactText (a message to another orchestrator, #414)', () => {
  test('redacts free text with the diff rules, keeping its lines and what is not a secret', () => {
    const r = redactText('Use this token: ghp_abcdefghijklmnopqrstuvwxyz0123\n@@ not a hunk @@\n- a list item\nplain line')
    expect(r.text).toBe('Use this token: [redacted]\n@@ not a hunk @@\n- a list item\nplain line')
    expect(r.redactions).toBe(1)
  })

  test('a private key block across lines goes whole', () => {
    const r = redactText('key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter')
    expect(r.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA')
    expect(r.text.split('\n')).toHaveLength(5)
    expect(r.text.endsWith('\nafter')).toBe(true)
  })

  test('text with nothing secret comes back as it was', () => {
    expect(redactText('Please run the systemd unit tests.\n')).toEqual({ text: 'Please run the systemd unit tests.\n', redactions: 0 })
  })
})

const COMMAND_SECRETS: [string, string][] = [
  [`curl -u 'admin:hunter22' https://x`, 'hunter22'],
  ['curl --user="admin:hunter22" https://x', 'hunter22'],
  ['curl -u admin:hunter22 https://x', 'hunter22'],
  ['curl --user admin:hunter22 https://x', 'hunter22'],
  ['curl -H "Authorization: Bearer abcdefghijklmnop1234" x', 'abcdefghijklmnop1234'],
  ['curl -H "Authorization: Token hunter22abc" x', 'hunter22abc'],
  ['curl -H "X-Api-Key: hunter22abc" x', 'hunter22abc'],
  ['git clone https://hunter22abcdef@github.com/a/b', 'hunter22abcdef'],
  ['git clone https://oauth2:hunter22abc@gitlab.com/a/b', 'hunter22abc'],
  ['mongodb+srv://user:hunter22@cluster0.x.net/db', 'hunter22'],
  ['redis-cli -a hunter22 ping', 'hunter22'],
  ['redis://:hunter22@host:6379', 'hunter22'],
  ['redis-cli --pass hunter22', 'hunter22'],
  ['docker login -u me -p hunter22', 'hunter22'],
  ['mysql -uroot -phunter22 db', 'hunter22'],
  ['mysql --password=hunter22', 'hunter22'],
  ['openssl enc -pass pass:hunter22', 'hunter22'],
  ['openssl rsa -passin pass:hunter22', 'hunter22'],
  ['gpg --passphrase hunter22 -d f', 'hunter22'],
  ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['export DATABASE_URL=postgres://u:hunter22@h/db', 'hunter22'],
  ['PGPASSWORD=hunter22 psql', 'hunter22'],
  ['MYSQL_PWD=hunter22 mysql', 'hunter22'],
  ['htpasswd -b f user hunter22', 'hunter22'],
  ['wget --http-password=hunter22 x', 'hunter22'],
  ['wget --password hunter22 x', 'hunter22'],
  ['az login -p hunter22', 'hunter22'],
  ['kubectl --token=hunter22abcdef get', 'hunter22abcdef'],
  ['kubectl create secret generic s --from-literal=pw=hunter22', 'hunter22'],
  ['npm config set //registry.npmjs.org/:_authToken hunter22abcdef', 'hunter22abcdef'],
  ['//registry.npmjs.org/:_authToken=hunter22abcdef', 'hunter22abcdef'],
  ['curl "https://x/api?api_key=hunter22abc&x=1"', 'hunter22abc'],
  ['curl "https://x/api?access_token=hunter22abc"', 'hunter22abc'],
  ['curl "https://x/?sig=hunter22abcdefghijklmnop"', 'hunter22abcdefghijklmnop'],
  ['curl -d "client_secret=hunter22abc" x', 'hunter22abc'],
  ['curl -d \'{"password":"hunter22"}\' x', 'hunter22'],
  ['jq .secret <<< \'{"secret":"hunter22"}\'', 'hunter22'],
  ['sshpass -p hunter22 ssh h', 'hunter22'],
  ['ssh://user:hunter22@host', 'hunter22'],
  ['ftp://user:hunter22@host', 'hunter22'],
  ['amqp://user:hunter22@host', 'hunter22'],
  ['https://user:p@ss@host/', 'ss@host'],
  ['Server=h;Database=d;User Id=u;Password=hunter22;', 'hunter22'],
  ['DefaultEndpointsProtocol=https;AccountKey=abcd1234abcd1234abcd1234==', 'abcd1234abcd1234abcd1234'],
  ['stripe sk_test_abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'],
  ['SLACK_WEBHOOK=https://hooks.slack.com/services/T000/B000/XXXXabcdefghijklmnop', 'XXXXabcdefghijklmnop'],
  ['https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
  ['-----BEGIN RSA PRIVATE KEY-----MIIEabc-----END RSA PRIVATE KEY-----', 'MIIEabc'],
  ['curl -H "Cookie: session=hunter22abc" x', 'hunter22abc'],
  ['curl -b "sid=hunter22abcdef" x', 'hunter22abcdef'],
  ['--client-secret hunter22abc', 'hunter22abc'],
  ['export OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"', 'abcdefghijklmnopqrstuvwxyz'],
  ['export MY_TOKEN=hunter22', 'hunter22'],
  ['ANTHROPIC_AUTH_TOKEN=hunter22abc claude', 'hunter22abc'],
  ['aws configure set aws_secret_access_key hunter22abcdef', 'hunter22abcdef'],
  ['echo aHVudGVyMjJhYmNkZWZnaGlqa2xtbm9w | base64 -d', 'aHVudGVyMjJhYmNkZWZnaGlqa2xtbm9w'],
  ['sqlcmd -S h -U sa -P hunter22', 'hunter22'],
  ['psql "host=h user=u password=hunter22 dbname=d"', 'hunter22'],
  ['mongo --username u --password hunter22', 'hunter22'],
  ['mongosh -p hunter22', 'hunter22'],
  ['smbclient -U user%hunter22 //h/s', 'hunter22'],
  ['http://u:hunter22@proxy:8080', 'hunter22'],
  ['HTTPS_PROXY=http://hunter22@proxy', 'hunter22'],
]

// Each row is a command a person runs and the secret in it. The Activity feed's row, its Command block, a failure's call and
// output, a prompt and a permission message all redact through this one function, so one table covers them all (#895).
describe('redactText: secrets in the commands people run (#895)', () => {
  for (const [command, secret] of COMMAND_SECRETS) {
    test(command, () => {
      const r = redactText(command)
      expect(r.text.includes(secret)).toBe(false)
      expect(r.redactions).toBeGreaterThan(0)
    })
  }
})

describe('redactText: commands that must not change (#895)', () => {
  const same = [
    'git clone git@github.com:a/b.git',
    'git clone ssh://git@github.com/a/b.git',
    'git clone https://github.com/a/b.git',
    'docker run -p 8080:80 nginx',
    'docker ps -a',
    'docker login -u me --password-stdin',
    'psql -p 5432 -h localhost',
    'curl -u "$USER:$PASS" https://x',
    'curl -u admin:$PASS https://x',
    'curl -u "admin:$PASS" https://x',
    'echo _auth\nhunter22',
    'curl -b cookies.txt https://x',
    'openssl enc -pass env:SECRET_VAR',
    'npm config set registry https://registry.npmjs.org/',
    'aws configure set region us-east-1',
    'redis-cli -h localhost ping',
    'ls -la /Users/someone/dev/podium/mod/podium-reporter/hooks',
    'https://example.com:8080/path?x=1',
  ]
  for (const command of same) test(command, () => expect(redactText(command).text).toBe(command))
})

