; Capitalized opening and self-closing JSX tags are component calls.
; Intrinsic and closing tags are intentionally ignored.

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
