// tree-sitter's bundled types declare Parser, Query, etc. inside `declare module "tree-sitter"`,
// but they omit the `Language` type (grammar objects passed to Parser.setLanguage()).
// tree-sitter grammar packages export these as their default/named exports.
declare module "tree-sitter" {
  export interface Language {
    /** Language identifier (e.g. "typescript", "tsx", "javascript"). */
    readonly name: string;
  }
}
