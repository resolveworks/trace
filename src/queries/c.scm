(struct_specifier name: (type_identifier) @name.definition.class body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name.definition.class)) @definition.class

(function_declarator declarator: (identifier) @name.definition.function) @definition.function

(type_definition declarator: (type_identifier) @name.definition.type) @definition.type

(enum_specifier name: (type_identifier) @name.definition.type) @definition.type

; call references (added by arbid)
(call_expression
    function: (identifier) @name.reference.call) @reference.call

(call_expression
    function: (field_expression
        field: (field_identifier) @name.reference.call)) @reference.call
