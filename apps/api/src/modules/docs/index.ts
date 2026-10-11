// Docs module — serves the generated OpenAPI spec at `/openapi.json` and the
// Scalar API reference UI at `/docs`. Owns no DB schema and no backup
// contribution; it only reads the in-process route table. See
// docs/develop/module/openapi-standard.md.

export { docsCspRelax, mountDocs } from "./docs.routes";
