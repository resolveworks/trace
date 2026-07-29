; Definitions shared by JavaScript, TypeScript, and TSX.

(method_definition
  name: (property_identifier) @name) @definition

[
  (class
    name: (_) @name)
  (class_declaration
    name: (_) @name)
] @definition

[
  (function_expression
    name: (identifier) @name)
  (function_declaration
    name: (identifier) @name)
  (generator_function
    name: (identifier) @name)
  (generator_function_declaration
    name: (identifier) @name)
] @definition

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]) @definition)

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]) @definition)

(assignment_expression
  left: [
    (identifier) @name
    (member_expression
      property: (property_identifier) @name)
  ]
  right: [(arrow_function) (function_expression)]) @definition

(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition

; Calls are indexed under the identifier or final member name used at the site.

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

(new_expression
  constructor: (identifier) @name) @reference.call

(new_expression
  constructor: (member_expression
    property: (property_identifier) @name)) @reference.call
