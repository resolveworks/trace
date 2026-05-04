; JSX element names that start with an uppercase letter are treated as component
; references (i.e. function calls). Intrinsic elements (div, span, etc.) are ignored.

(jsx_self_closing_element
  name: (identifier) @name
  (#match? @name "^[A-Z]")) @reference.call

(jsx_opening_element
  name: (identifier) @name
  (#match? @name "^[A-Z]")) @reference.call

(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @name)
  (#match? @name "^[A-Z]")) @reference.call

(jsx_opening_element
  name: (member_expression
    property: (property_identifier) @name)
  (#match? @name "^[A-Z]")) @reference.call
