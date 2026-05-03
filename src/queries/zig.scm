(FnProto) @name.definition.function
(VarDecl "const" @name.definition.constant)
(VarDecl "var"   @name.definition.variable)

; call references (added by arbid)
(call_expression
    function: (identifier) @name.reference.call) @reference.call

(call_expression
    function: (field_expression
        member: (identifier) @name.reference.call)) @reference.call
