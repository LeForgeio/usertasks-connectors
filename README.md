# UserTasks connectors by LeForge

Custom workflow actions for [UserTasks](https://github.com/homepresso/User-Tasks)
that connect a workflow to self-hosted tools. You upload them to a stock
UserTasks install. You do not need a fork or a custom build.

| Action | What it does | Operations |
|---|---|---|
| [`ntfy`](actions/ntfy) | Push notifications through an ntfy server | 2 |
| [`home_assistant`](actions/home_assistant) | Read states, call services, fire events, render templates | 6 |
| [`leforge`](actions/leforge) | Run LeForge actions and publish Event Fabric events | 4 |
| [`gitea`](actions/gitea) | Issues, pull requests, commit statuses and Actions runs | 10 |
| [`coolify`](actions/coolify) | Applications, deploys, restarts and environment variables | 8 |
| [`authentik`](actions/authentik) | Users, groups and applications | 8 |
| [`paperclip`](actions/paperclip) | Issues, comments and agent wake-ups | 5 |

Each action folder has a README with its operations and setup.

## How it works

A UserTasks custom action runs in a sandbox. It can call only the hosts in
its manifest that an administrator approves. Your server is different from
everyone else's, so you package each action for your own server URL:

```bash
npm install
npm run package -- gitea --url https://git.example.com
```

This runs the tests and writes `release/gitea-1.0.0.zip`. Then, in UserTasks:

1. **Extensibility > Workflow actions > Upload**, and choose the zip.
2. **Manage > Access** on the action: approve the host, and set the secret
   `api_token` (the API token for that server).
3. In the workflow designer, open **Custom actions** in the palette and drop
   the action on the canvas. Pick an operation and map its inputs.

The token goes in the request header as `Bearer secret://api_token`. The
UserTasks host puts the value in, so the token never enters the sandbox.

Every operation returns `http_status`, `http_ok` and `response` (the full body), plus
its own outputs. A status that is not 2xx fails the step. A 429 or 5xx can
be retried with the node's retry setting.

A private address (for example `192.168.x.x`) needs `ALLOW_PRIVATE_EGRESS=true`
on the UserTasks server.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Type check, then run every action in the real QuickJS sandbox against mock servers |
| `npm test -- ntfy --verbose` | One action, with outputs and logs |
| `npm run build -- <name> --url <url>` | Build into `dist/<name>/` without a zip |
| `npm run package -- <name> --url <url>` | Test, build and zip one action for your server |
| `npm run package -- <name> --url <url> --sign key.pem` | The same, with an ed25519 signature (`openssl genpkey -algorithm ed25519 -out key.pem`) |
| `npm run gen` | Write each action's `manifest.json`, `action.ts` and `README.md` from its `spec.json` |

## Layout

```
actions/<name>/spec.json        the REST calls: the only file you edit
actions/<name>/test/cases.json  request and response checks
actions/<name>/manifest.json    generated (npm run gen)
actions/<name>/action.ts        generated
actions/<name>/README.md        generated
lib/rest.ts                     the shared engine: spec -> HTTP calls
harness/run.ts                  the test runner (the UserTasks sandbox)
vendor/usertasks-action/        the UserTasks action SDK (Apache-2.0)
scripts/                        gen, build, test, package
```

## Add an operation or a new action

1. Edit `actions/<name>/spec.json` (or copy a folder for a new action).
   - `path` and `query` use `{{input}}` placeholders.
   - In a JSON `body`, `"{{x}}"` becomes a string and a bare `{{x}}` becomes
     a JSON value (number, true/false, list or object). A key whose input is
     empty is left out.
   - A `body` of only `{{x}}` sends the value as it is (text for a `text/*`
     content type).
2. `npm run gen`
3. Add cases to `actions/<name>/test/cases.json`, then `npm test`.
4. Bump `version` in `spec.json` when the operations change. UserTasks
   refuses a new upload with the same version and different bytes.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
