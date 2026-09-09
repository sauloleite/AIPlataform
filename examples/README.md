# Examples

Two programs, one in each language, doing the same thing against a local
platform: sign in, list the aliases the project may use, ask a question, and
stream one.

They exist as the acceptance test for the SDKs. The promise is that using this
platform takes no API key of your own and no cloud account — so if either of
these needs one, the promise is false.

```bash
make dev && make seed      # the platform, and a project with a budget
node examples/chat.mjs     # TypeScript
uv run python examples/chat.py   # Python
```

Both read the same environment, and both default to what `make dev` and
`make seed` produce:

| Variable                            | Default                 |
| ----------------------------------- | ----------------------- |
| `PLATFORM_BASE_URL`                 | `http://localhost:8080` |
| `IDENTITY_BOOTSTRAP_ADMIN_EMAIL`    | `admin@aia.local`       |
| `IDENTITY_BOOTSTRAP_ADMIN_PASSWORD` | `change-me-now`         |
| `AIA_PROJECT_SLUG`                  | `sample`                |

The sign-in step is not part of the SDK, and deliberately so: how a program
obtains a token is its own business — a password here, a personal access token
in a script, client credentials in a service. What the SDK takes is the token,
or a function that produces one.
