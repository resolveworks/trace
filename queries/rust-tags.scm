; Type and namespace definitions.

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.class

(union_item
  name: (type_identifier) @name) @definition.class

(type_item
  name: (type_identifier) @name) @definition.type

(trait_item
  name: (type_identifier) @name) @definition.interface

(mod_item
  name: (identifier) @name) @definition.module

(macro_definition
  name: (identifier) @name) @definition.macro

; Free functions and methods with bodies both use function_item syntax.

(function_item
  name: (identifier) @name) @definition.function

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
