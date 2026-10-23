// Docs module — serves the generated OpenAPI spec at `/openapi.json` and
// redirects `/docs` to an external viewer. Owns no DB schema and no backup
// contribution; it only reads the in-process route table. See
// docs/develop/module/openapi-standard.md.

export { mountDocs } from "./docs.routes";
