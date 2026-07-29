(class_definition
  name: (identifier) @name) @definition

(function_definition
  name: (identifier) @name) @definition

(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name)) @reference.call
