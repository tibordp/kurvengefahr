//! THE builtin table — the single source of truth for the Logo vocabulary. The parser reads
//! arities from it (Logo parses greedily by arity), the evaluator dispatches on `B`, the analyzer
//! flags unknown names against it, and `logo_builtins()` serializes it for editor autocomplete.
//! Adding a builtin = one entry here + one match arm in `eval.rs`. Nothing else may hardcode a
//! builtin name.

/// Builtin ids. Grouped like the table below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum B {
    // turtle
    Forward, Back, Right, Left, PenUp, PenDown, Home, SetXY, SetPos, SetX, SetY, SetHeading,
    Arc, Arc2, XCor, YCor, Heading, Towards, Pos,
    // pen
    SetPressure, Pressure, SetPen, Pen,
    // control
    Repeat, RepCount, If, IfElse, For, While, Foreach, Map, Filter, Run, Output, Stop,
    // variables
    Make, Local, LocalMake, Thing, Param,
    // math
    Sum, Difference, Product, Quotient, Remainder, Modulo, MinusFn, Abs, Int, Round, Sqrt,
    Power, Exp, Ln, Log10, Sin, Cos, Tan, Arctan, Pi, Min, Max,
    // logic
    And, Or, Not, True, False,
    // words & lists
    Word, List, Sentence, FPut, LPut, First, Last, ButFirst, ButLast, Item, Count,
    EmptyP, ListP, NumberP, WordP, MemberP, Reverse,
    // random
    Random, Pick, ReRandom,
    // template
    Question,
    // io (accepted, ignored — there is no console surface; keeps textbook code running)
    Print, Show,
}

pub struct BuiltinDef {
    pub id: B,
    /// Canonical name (lowercase).
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    /// Default arity — how many arguments a bare (unparenthesized) call consumes.
    pub arity: u8,
    /// May take extra arguments in the parenthesized form `(sum 1 2 3)`.
    pub vararg: bool,
    /// Argument names for signatures/completion detail.
    pub args: &'static [&'static str],
    pub doc: &'static str,
    /// Completion group: turtle / pen / control / vars / math / logic / words / random / io.
    pub category: &'static str,
}

macro_rules! b {
    ($id:ident, $name:literal, [$($al:literal),*], $arity:literal, $vararg:literal, [$($arg:literal),*], $cat:literal, $doc:literal) => {
        BuiltinDef { id: B::$id, name: $name, aliases: &[$($al),*], arity: $arity, vararg: $vararg, args: &[$($arg),*], category: $cat, doc: $doc }
    };
}

pub static BUILTINS: &[BuiltinDef] = &[
    // ── turtle ──────────────────────────────────────────────────────────────────────────────────
    b!(Forward, "forward", ["fd"], 1, false, ["dist"], "turtle", "Move forward dist mm, drawing if the pen is down."),
    b!(Back, "back", ["bk"], 1, false, ["dist"], "turtle", "Move backward dist mm, drawing if the pen is down."),
    b!(Right, "right", ["rt"], 1, false, ["deg"], "turtle", "Turn clockwise by deg degrees."),
    b!(Left, "left", ["lt"], 1, false, ["deg"], "turtle", "Turn counterclockwise by deg degrees."),
    b!(PenUp, "penup", ["pu"], 0, false, [], "turtle", "Lift the pen: moves stop drawing."),
    b!(PenDown, "pendown", ["pd"], 0, false, [], "turtle", "Lower the pen: moves draw."),
    b!(Home, "home", [], 0, false, [], "turtle", "Return to (0 0) heading 0, drawing if the pen is down."),
    b!(SetXY, "setxy", [], 2, false, ["x", "y"], "turtle", "Move to (x y) in mm, drawing if the pen is down."),
    b!(SetPos, "setpos", [], 1, false, ["pos"], "turtle", "Move to pos, a two-number list [x y], drawing if the pen is down."),
    b!(SetX, "setx", [], 1, false, ["x"], "turtle", "Move horizontally to x, keeping y."),
    b!(SetY, "sety", [], 1, false, ["y"], "turtle", "Move vertically to y, keeping x."),
    b!(SetHeading, "setheading", ["seth"], 1, false, ["deg"], "turtle", "Face heading deg (0 = up, clockwise)."),
    b!(Arc, "arc", [], 2, false, ["deg", "radius"], "turtle", "Draw an arc of deg degrees at radius around the turtle, starting at its heading, clockwise. The turtle does not move."),
    b!(Arc2, "arc2", [], 2, false, ["deg", "radius"], "turtle", "Walk an arc of deg degrees along a circle of the given radius; positive deg curves right. The turtle ends up on the arc, turned by deg."),
    b!(XCor, "xcor", [], 0, false, [], "turtle", "The turtle's x coordinate (mm)."),
    b!(YCor, "ycor", [], 0, false, [], "turtle", "The turtle's y coordinate (mm)."),
    b!(Heading, "heading", [], 0, false, [], "turtle", "The turtle's heading in degrees (0 = up, clockwise)."),
    b!(Towards, "towards", [], 1, false, ["pos"], "turtle", "The heading from the turtle to pos, a two-number list [x y]."),
    b!(Pos, "pos", [], 0, false, [], "turtle", "The turtle's position as a list [x y]."),
    // ── pen ─────────────────────────────────────────────────────────────────────────────────────
    b!(SetPressure, "setpressure", [], 1, false, ["p"], "pen", "Set pen pressure for what follows: 0 lightest to 1 full."),
    b!(Pressure, "pressure", [], 0, false, [], "pen", "The current pen pressure (0 to 1)."),
    b!(SetPen, "setpen", [], 1, false, ["n"], "pen", "Switch to pen n of the palette (0 is the first pen)."),
    b!(Pen, "pen", [], 0, false, [], "pen", "The current pen number."),
    // ── control ─────────────────────────────────────────────────────────────────────────────────
    b!(Repeat, "repeat", [], 2, false, ["n", "block"], "control", "Run block n times."),
    b!(RepCount, "repcount", [], 0, false, [], "control", "The current repeat iteration, counting from 1."),
    b!(If, "if", [], 2, false, ["cond", "block"], "control", "Run block if cond is true."),
    b!(IfElse, "ifelse", [], 3, false, ["cond", "then", "else"], "control", "Run then if cond is true, else otherwise. Outputs the branch's value if it has one."),
    b!(For, "for", [], 2, false, ["control", "block"], "control", "for [i start end step?] [block] — run block with :i counting from start to end."),
    b!(While, "while", [], 2, false, ["cond", "block"], "control", "Run block as long as the cond list evaluates true."),
    b!(Foreach, "foreach", [], 2, false, ["data", "template"], "control", "Run template once per item of data, with ? as the item."),
    b!(Map, "map", [], 2, false, ["template", "data"], "control", "Output the list made by evaluating template (with ? as the item) for each item of data."),
    b!(Filter, "filter", [], 2, false, ["template", "data"], "control", "Output the items of data for which template (with ? as the item) is true."),
    b!(Run, "run", [], 1, false, ["block"], "control", "Run a list as instructions; outputs its value if it has one."),
    b!(Output, "output", ["op"], 1, false, ["value"], "control", "Return value from the current procedure."),
    b!(Stop, "stop", [], 0, false, [], "control", "Return from the current procedure without a value."),
    // ── variables ───────────────────────────────────────────────────────────────────────────────
    b!(Make, "make", [], 2, false, ["name", "value"], "vars", "Set variable name (a quoted word) to value. Creates a global if no local exists."),
    b!(Local, "local", [], 1, false, ["name"], "vars", "Declare name (a quoted word, or list of them) local to the current procedure."),
    b!(LocalMake, "localmake", [], 2, false, ["name", "value"], "vars", "Declare name local and set it to value."),
    b!(Thing, "thing", [], 1, false, ["name"], "vars", "The value of the variable named by name — thing \"x is the same as :x."),
    b!(Param, "param", [], 2, false, ["name", "default"], "vars", "Declare an inspector-adjustable parameter: param \"size 40, or param \"size 40 [10 80] with a range. Defines :size."),
    // ── math ────────────────────────────────────────────────────────────────────────────────────
    b!(Sum, "sum", [], 2, true, ["a", "b"], "math", "a + b. Parenthesize for more: (sum 1 2 3)."),
    b!(Difference, "difference", [], 2, false, ["a", "b"], "math", "a - b."),
    b!(Product, "product", [], 2, true, ["a", "b"], "math", "a × b. Parenthesize for more: (product 2 3 4)."),
    b!(Quotient, "quotient", [], 2, false, ["a", "b"], "math", "a ÷ b."),
    b!(Remainder, "remainder", [], 2, false, ["a", "b"], "math", "Remainder of a ÷ b, with the sign of a."),
    b!(Modulo, "modulo", [], 2, false, ["a", "b"], "math", "a modulo b, with the sign of b."),
    b!(MinusFn, "minus", [], 1, false, ["a"], "math", "-a."),
    b!(Abs, "abs", [], 1, false, ["a"], "math", "Absolute value."),
    b!(Int, "int", [], 1, false, ["a"], "math", "Truncate toward zero."),
    b!(Round, "round", [], 1, false, ["a"], "math", "Round to the nearest integer."),
    b!(Sqrt, "sqrt", [], 1, false, ["a"], "math", "Square root."),
    b!(Power, "power", [], 2, false, ["a", "b"], "math", "a raised to b."),
    b!(Exp, "exp", [], 1, false, ["a"], "math", "e to the a."),
    b!(Ln, "ln", [], 1, false, ["a"], "math", "Natural logarithm."),
    b!(Log10, "log10", [], 1, false, ["a"], "math", "Base-10 logarithm."),
    b!(Sin, "sin", [], 1, false, ["deg"], "math", "Sine of an angle in degrees."),
    b!(Cos, "cos", [], 1, false, ["deg"], "math", "Cosine of an angle in degrees."),
    b!(Tan, "tan", [], 1, false, ["deg"], "math", "Tangent of an angle in degrees."),
    b!(Arctan, "arctan", [], 1, false, ["a"], "math", "Arctangent, in degrees."),
    b!(Pi, "pi", [], 0, false, [], "math", "3.14159…"),
    b!(Min, "min", [], 2, true, ["a", "b"], "math", "The smaller of a and b. Parenthesize for more."),
    b!(Max, "max", [], 2, true, ["a", "b"], "math", "The larger of a and b. Parenthesize for more."),
    // ── logic ───────────────────────────────────────────────────────────────────────────────────
    b!(And, "and", [], 2, true, ["a", "b"], "logic", "True if all arguments are true."),
    b!(Or, "or", [], 2, true, ["a", "b"], "logic", "True if any argument is true."),
    b!(Not, "not", [], 1, false, ["a"], "logic", "True if a is false."),
    b!(True, "true", [], 0, false, [], "logic", "The boolean true."),
    b!(False, "false", [], 0, false, [], "logic", "The boolean false."),
    // ── words & lists ───────────────────────────────────────────────────────────────────────────
    b!(Word, "word", [], 2, true, ["a", "b"], "words", "Join words into one word."),
    b!(List, "list", [], 2, true, ["a", "b"], "words", "Make a list of the arguments."),
    b!(Sentence, "sentence", ["se"], 2, true, ["a", "b"], "words", "Make a flat list: list arguments are spliced in."),
    b!(FPut, "fput", [], 2, false, ["item", "list"], "words", "A copy of list with item added at the front."),
    b!(LPut, "lput", [], 2, false, ["item", "list"], "words", "A copy of list with item added at the end."),
    b!(First, "first", [], 1, false, ["x"], "words", "The first item of a list, or first character of a word."),
    b!(Last, "last", [], 1, false, ["x"], "words", "The last item of a list, or last character of a word."),
    b!(ButFirst, "butfirst", ["bf"], 1, false, ["x"], "words", "Everything but the first item/character."),
    b!(ButLast, "butlast", ["bl"], 1, false, ["x"], "words", "Everything but the last item/character."),
    b!(Item, "item", [], 2, false, ["n", "x"], "words", "The nth item (1-based) of a list or word."),
    b!(Count, "count", [], 1, false, ["x"], "words", "The number of items in a list, or characters in a word."),
    b!(EmptyP, "empty?", ["emptyp"], 1, false, ["x"], "words", "True if x is an empty list or word."),
    b!(ListP, "list?", ["listp"], 1, false, ["x"], "words", "True if x is a list."),
    b!(NumberP, "number?", ["numberp"], 1, false, ["x"], "words", "True if x is a number."),
    b!(WordP, "word?", ["wordp"], 1, false, ["x"], "words", "True if x is a word (numbers count)."),
    b!(MemberP, "member?", ["memberp"], 2, false, ["item", "x"], "words", "True if item is in the list x (or a substring of the word x)."),
    b!(Reverse, "reverse", [], 1, false, ["x"], "words", "The list (or word) reversed."),
    // ── random ──────────────────────────────────────────────────────────────────────────────────
    b!(Random, "random", [], 1, false, ["n"], "random", "A random integer from 0 to n-1. Deterministic per the element's seed."),
    b!(Pick, "pick", [], 1, false, ["list"], "random", "A random item of the list."),
    b!(ReRandom, "rerandom", [], 1, false, ["n"], "random", "Re-seed the random sequence with n."),
    // ── template ────────────────────────────────────────────────────────────────────────────────
    b!(Question, "?", [], 0, false, [], "control", "The current item inside map / filter / foreach templates."),
    // ── io ──────────────────────────────────────────────────────────────────────────────────────
    b!(Print, "print", ["pr"], 1, true, ["x"], "io", "Accepted for compatibility; there is no console, so it draws and prints nothing."),
    b!(Show, "show", [], 1, true, ["x"], "io", "Accepted for compatibility; there is no console, so it draws and prints nothing."),
];

/// Look up a builtin by canonical name or alias (input must already be lowercase).
pub fn lookup(name: &str) -> Option<&'static BuiltinDef> {
    BUILTINS.iter().find(|b| b.name == name || b.aliases.contains(&name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_by_name_and_alias() {
        assert_eq!(lookup("forward").unwrap().id, B::Forward);
        assert_eq!(lookup("fd").unwrap().id, B::Forward);
        assert_eq!(lookup("bf").unwrap().id, B::ButFirst);
        assert!(lookup("no-such").is_none());
    }

    #[test]
    fn no_duplicate_names() {
        let mut seen = std::collections::HashSet::new();
        for b in BUILTINS {
            assert!(seen.insert(b.name), "duplicate builtin name {}", b.name);
            for a in b.aliases {
                assert!(seen.insert(a), "duplicate alias {}", a);
            }
        }
    }
}
