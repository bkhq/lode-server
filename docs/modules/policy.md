# Policy Module

The policy module implements Zanzibar-style relation tuples for authorization checks and permission inspection.

> Building a new module? Use [`policy-standard.md`](../develop/module/policy-standard.md) —
> the action-based wrapper that hides namespaces and relations behind
> verbs like `"document:update"`. This page documents the underlying
> engine; the standard is the recommended integration surface.

Code layout:

```text
apps/api/src/modules/policy/
  schema.ts                # `relation_tuples` (group memberships live in
                           # `account.group_members`, not here)
  namespace-config.ts      # `item` / `group` namespace declarations + rewrite rules
  zanzibar.engine.ts       # check / expand / listUserResources — routes
                           # `group:*#member` reads to account.group-members
  policy.service.ts        # tuple CRUD + batch ops (no group helpers)
  resource-group.service.ts
  policy.routes.ts         # rejects group:X#member writes — use account routes
  policy.backup.ts         # backup contribution
  index.ts                 # registers backup contribution
```

## Tuple Model

A tuple grants a relation on an object to a subject:

```text
namespace:objectId#relation@subjectNamespace:subjectId
namespace:objectId#relation@subjectNamespace:subjectId#subjectRelation
```

Examples:

```text
document:doc123#viewer@user:user123              # relation_tuples
document:doc123#editor@group:group123#member     # relation_tuples
group:group123#member@user:user123               # account.group_members
```

Group membership rows live in `account.group_members` (owned by the account
module). The engine reads them through `group-members.service` so the policy
module can be dropped without losing user-group features. `POST /api/policy/tuples`
refuses to write `group:*#member` — callers must use
`POST /api/account/groups/:id/members`.

## Routes

All policy routes require admin access.

| Method | Path | Description |
|---|---|---|
| GET | `/api/policy/tuples` | Lists relation tuples. |
| POST | `/api/policy/tuples` | Creates a relation tuple. |
| PATCH | `/api/policy/tuples/:id` | Replaces a tuple with the same object and subject but a new relation. |
| DELETE | `/api/policy/tuples/:id` | Deletes a relation tuple. |
| POST | `/api/policy/tuples/batch` | Batch creates and deletes tuples. |
| POST | `/api/policy/check` | Checks whether a subject has a relation on an object. |
| POST | `/api/policy/expand` | Expands a relation tree. |
| GET | `/api/policy/users/:id/access` | Lists tuples where the user is the subject. |
| GET | `/api/policy/groups/:id/access` | Lists tuples where the group is the subject. |
| GET | `/api/policy/manifest` | Permission manifest (resources, actions, namespaces) — drives the admin UI. |
| GET | `/api/policy/entities` | Lists users, groups, and resource groups for the policy UI. |
| GET | `/api/policy/resource-groups` | Lists resource groups. |
| POST | `/api/policy/resource-groups` | Creates a resource group. |
| PATCH | `/api/policy/resource-groups/:id` | Renames a resource group (`name`, `description`). |
| DELETE | `/api/policy/resource-groups/:id` | Deletes a resource group. |
| GET | `/api/policy/resource-groups/:id/members` | Lists resource group members. |
| POST | `/api/policy/resource-groups/:id/members` | Adds a resource group member. |
| DELETE | `/api/policy/resource-groups/:id/members/:tupleId` | Removes a resource group member. |

## Create Tuple Request

```json
{
  "namespace": "document",
  "objectId": "doc123",
  "relation": "viewer",
  "subjectNamespace": "group",
  "subjectId": "group123",
  "subjectRelation": "member"
}
```

For group subjects, `subjectRelation` defaults to `member` when omitted.

A direct subject is reported as `subjectRelation: null` on every read and
accepted as `null` / omitted on every write. In storage the column is
`NOT NULL` and a direct subject is the empty string — that lets
`idx_tuples_unique` enforce uniqueness for direct grants, which it cannot
do with NULL (SQLite treats every NULL as distinct). The service layer maps
between the two; nothing outside `policy.service.ts` needs to know.

Resource groups are rows in `resource_groups` (`id`, `name`, `description`).
Only their edges live in `relation_tuples`: membership as
`<ns>:<id>#parent@resource_group:<gid>`, access grants as
`resource_group:<gid>#<relation>@<subject>`.

## Check Request

```json
{
  "namespace": "document",
  "objectId": "doc123",
  "relation": "viewer",
  "subjectNamespace": "user",
  "subjectId": "user123"
}
```

## Resource Groups

Resource groups are policy-managed groupings of objects. A member is added by object namespace and object ID:

```json
{
  "namespace": "document",
  "objectId": "doc123"
}
```

## Account Subjects

Users and groups come from the account module. Group membership uses group IDs in route paths:

```text
POST /api/account/groups/:id/members
DELETE /api/account/groups/:id/members/:userId
```

Do not use group names in account group member route paths unless the route implementation changes.
