# Account Module

The account module owns authentication, sessions, users, groups, user preferences, and TOTP.

Code layout:

```text
apps/api/src/modules/account/
  account.routes.ts            # aggregator: mounts auth + users + groups
  account.backup.ts            # one BackupContribution for users + groups + preferences
  index.ts                     # registers backup contribution + OAuth auth provider
  auth/
    auth.routes.ts
    auth.service.ts            # session lookup, refresh, default-admin promotion
    oidc.ts                    # OIDC client (oauth4webapi)
    session-cookie.ts          # cookie name + parse / write helpers
    schema.ts                  # `sessions` table
    index.ts
  users/
    schema.ts                  # `users`, `user_preferences`, `user_totp_devices`
    users.routes.ts
    users.service.ts
    totp.service.ts
    index.ts
  groups/
    schema.ts                  # `groups` + `group_members`
    groups.routes.ts
    groups.service.ts          # group CRUD; delegates membership writes
    group-members.service.ts   # owns user ↔ group and nested group ↔ group edges
    index.ts
```

## Authentication

Authentication uses an external OAuth/OIDC provider with authorization code flow and PKCE.

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/auth/mode` | Public | Reports the active login mode (`oauth` or `single-user`) so the SPA picks the right login form. |
| GET | `/api/account/auth/login` | Public | Starts OAuth login. |
| GET | `/api/account/auth/callback` | Public | Handles OAuth callback and creates a local session. |
| POST | `/api/account/auth/login-local` | Public | Single-user login with `username` + `password`. Active only when `SINGLE_USER_MODE=true`. |
| POST | `/api/account/auth/logout` | Authenticated | Deletes the local session. |
| GET | `/api/account/auth/logout-url` | Public | Returns the configured upstream logout URL. |
| POST | `/api/account/auth/totp/verify` | Public | Completes login-time TOTP verification. |

The callback creates or updates a local user record based on OAuth userinfo. OAuth/OIDC provider settings are read from environment variables at runtime, not from editable database settings. `DEFAULT_ADMIN` lists identities that are always admins: a matching login is granted the role on every login, including an account that already exists, and regardless of whether other admins exist. An entry containing `@` matches only an email the provider marks verified; any other entry matches the username. The setting grants and never revokes.

## Current User

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/me` | Authenticated | Current user profile and groups. |
| GET | `/api/account/me/groups` | Authenticated | Current user's groups. |
| GET | `/api/account/me/preferences/:key` | Authenticated | Reads one preference. |
| PUT | `/api/account/me/preferences/:key` | Authenticated | Writes one preference. |
| GET | `/api/account/me/totp` | Authenticated | Lists TOTP devices. |
| POST | `/api/account/me/totp` | Authenticated | Creates a TOTP setup. |
| POST | `/api/account/me/totp/:deviceId/confirm` | Authenticated | Confirms a TOTP setup. |
| DELETE | `/api/account/me/totp/:deviceId` | Authenticated | Deletes a TOTP device. |
| POST | `/api/account/me/totp/verify` | Authenticated | Verifies a TOTP code for step-up operations. |

## Users

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/visible-users` | Authenticated | Active user directory exposed to every signed-in caller, for assignment and sharing pickers. |
| GET | `/api/account/users` | Admin | User list. |
| GET | `/api/account/users/:id` | Admin | User detail. |
| PATCH | `/api/account/users/:id` | Admin | Updates role, status, or profile fields. |
| GET | `/api/account/users/:id/groups` | Admin | User group membership. |

## Groups

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/groups` | Admin | Group list. |
| POST | `/api/account/groups` | Admin | Creates a group. |
| GET | `/api/account/groups/:id` | Admin | Group detail. |
| PATCH | `/api/account/groups/:id` | Admin | Updates a group. |
| DELETE | `/api/account/groups/:id` | Admin | Deletes a group. |
| GET | `/api/account/groups/:id/members` | Admin | Group members. |
| POST | `/api/account/groups/:id/members` | Admin | Adds a member. |
| DELETE | `/api/account/groups/:id/members/:userId` | Admin | Removes a member. |

### Groups from the identity provider

Set `OAUTH_GROUPS_CLAIM` to the claim that carries group names (userinfo
first, then the id_token) and every OIDC login syncs the user's memberships:

- A claimed group that does not exist is created with `source: "idp"`.
- The user is added to each claimed `idp` group and removed from every `idp`
  group the claim no longer lists.
- `local` groups — created by an admin — are never joined or left. A claimed
  name that belongs to a local group is skipped with a warning, so the IdP
  cannot pick up whatever an admin granted that group.
- A login whose tokens lack the claim leaves memberships unchanged, so a
  missing scope does not wipe them; an empty list is an empty set.

`idp` groups refuse manual member changes and renames with
`409 GROUP_MANAGED_BY_IDP`; their description can still be edited, and they
can be deleted (a later login recreates them). Many IdPs only send the claim
when a scope asks for it — add it with `OAUTH_SCOPES`, for example
`openid profile email groups`.

## Password Accounts

`LOCAL_LOGIN=true` lets users sign in with a username and password next to
OIDC, so a deployment does not depend on an identity provider. Both are
offered on the login page when OIDC is configured. Single-user mode is a
different, exclusive mode and takes precedence if it is on.

| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/api/account/users` | Admin | Creates an account (`username`, `name`, `email`, `role`, `password`). |
| POST | `/api/account/users/:id/password` | Admin | Sets or resets a password and ends that user's sessions. On an IdP-only account it adds password sign-in. |
| POST | `/api/account/auth/login-local` | Public | Signs in. Answers `{ totpRequired: true }` when two-step verification is on; the code then goes to `/account/auth/totp/verify`. |

Passwords are 12–128 characters, stored only as PBKDF2 hashes (`users.password_hash`,
never returned by any route; it is part of a backup of the users module, which
is as sensitive as the database). Failures answer the same whether the
username exists, and ten failures lock the username for 15 minutes.

**First admin.** With `LOCAL_LOGIN`, `SINGLE_USER_USERNAME` and
`SINGLE_USER_PASSWORD_HASH` (or `_FILE`) name a bootstrap admin that is
created at every boot as an active admin with that password — the environment
is authoritative, so a lost password is recovered by changing the hash.

**IdP and password accounts.** A username is self-chosen at many IdPs, so an
OIDC login never takes over a password account by username: it fails with an
account-conflict message. Only a verified email the IdP vouches for links the
two, after which the account keeps its password and gains the IdP identity.

## Personal API Tokens

A signed-in user can mint tokens for scripts and other services under
**Settings → API tokens**, or through the API:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/token-scopes` | Session | Scopes registered by modules. |
| GET | `/api/account/me/tokens` | Session | The caller's tokens, without secrets. |
| POST | `/api/account/me/tokens` | Session | Creates a token (`name`, `scopes`, optional `expiresInDays`); the response carries the secret once. |
| DELETE | `/api/account/me/tokens/:id` | Session | Revokes a token. |

A token is sent as `Authorization: Bearer pat_…`, needs no CSRF header, and
acts as its user — role, policy checks and creation quota all apply. Only a
SHA-256 of the token is stored.

Access is deny-by-default. A module registers each scope with the routes it
opens, from its `index.ts`:

```ts
import { registerTokenScope } from "@/shared/lib/token-scopes";

registerTokenScope({
  name: "invoices:read",
  description: "Read invoices",
  routes: [{ method: "GET", path: "/invoices" }, { method: "GET", path: "/invoices/*" }],
});
```

Paths are relative to `/api`; `:name` matches one segment and a trailing `*`
matches the rest. A token on a route that none of its scopes lists gets 403,
so routes nobody registered — token management itself, admin settings — stay
closed to tokens. An unknown, expired or revoked token, or one whose user is
disabled, is unauthenticated (401). Shipped scopes: `account:read`,
`issues:read`, `issues:write`, `documents:read`, `documents:write`.

Tokens are not part of backups, like sessions.

## Policy Integration

Users and groups are policy subjects. Resource grants to users and to groups
are stored in `relation_tuples`, but group **membership** lives in the
account-owned `group_members` table — this lets a deployment drop the policy
module while keeping user-group features:

```text
document:doc123#viewer@user:user123              # in relation_tuples
document:doc123#viewer@group:group123#member     # in relation_tuples
group:group123#member@user:user123               # in group_members
group:parent-team#member@group:child-team#member # in group_members (nested)
```

The Zanzibar engine routes reads on `group:*#member` through
`group-members.service` so the two stores never disagree. The generic
`POST /api/policy/tuples` endpoint rejects writes to `group:*#member`;
callers must use `POST /api/account/groups/:id/members` instead.

Policy helper routes for account subjects live in the policy route module:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/policy/users/:id/access` | Admin | Tuples where the user is the subject. |
| GET | `/api/policy/groups/:id/access` | Admin | Tuples where the group is the subject. |
