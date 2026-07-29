; Type and namespace definitions.

(struct_item
  name: (type_identifier) @name) @definition

(enum_item
  name: (type_identifier) @name) @definition

(union_item
  name: (type_identifier) @name) @definition

(type_item
  name: (type_identifier) @name) @definition

(trait_item
  name: (type_identifier) @name) @definition

(mod_item
  name: (identifier) @name) @definition

(macro_definition
  name: (identifier) @name) @definition

; Free functions and methods with bodies both use function_item syntax.

(function_item
  name: (identifier) @name) @definition

; Direct, method, associated, and generic calls.

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @reference.call

(call_expression
  function: (scoped_identifier
    name: (identifier) @name)) @reference.call

(call_expression
  function: (generic_function
    function: (identifier) @name)) @reference.call

(call_expression
  function: (generic_function
    function: (field_expression
      field: (field_identifier) @name))) @reference.call

(call_expression
  function: (generic_function
    function: (scoped_identifier
      name: (identifier) @name))) @reference.call

(macro_invocation
  macro: (identifier) @name) @reference.call

(macro_invocation
  macro: (scoped_identifier
    name: (identifier) @name)) @reference.call
