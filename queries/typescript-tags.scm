; TypeScript definitions layered on top of javascript-tags.scm.

(function_signature
  name: (identifier) @name) @definition

(method_signature
  name: (property_identifier) @name) @definition

(abstract_method_signature
  name: (property_identifier) @name) @definition

(abstract_class_declaration
  name: (type_identifier) @name) @definition

(interface_declaration
  name: (type_identifier) @name) @definition

(type_alias_declaration
  name: (type_identifier) @name) @definition

(enum_declaration
  name: (identifier) @name) @definition

[
  (module
    name: (identifier) @name)
  (internal_module
    name: (identifier) @name)
] @definition
