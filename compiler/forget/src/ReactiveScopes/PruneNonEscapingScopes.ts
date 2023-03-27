/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from "invariant";
import prettyFormat from "pretty-format";
import { CompilerError } from "../CompilerError";
import {
  Effect,
  IdentifierId,
  InstructionId,
  Pattern,
  Place,
  ReactiveFunction,
  ReactiveInstruction,
  ReactiveScopeBlock,
  ReactiveStatement,
  ReactiveTerminal,
  ReactiveTerminalStatement,
  ReactiveValue,
  ScopeId,
} from "../HIR";
import { log } from "../Utils/logger";
import { assertExhaustive } from "../Utils/utils";
import { getPlaceScope } from "./BuildReactiveBlocks";
import { printReactiveFunction } from "./PrintReactiveFunction";
import {
  eachReactiveValueOperand,
  ReactiveFunctionTransform,
  ReactiveFunctionVisitor,
  Transformed,
  visitReactiveFunction,
} from "./visitors";

/**
 * This pass prunes reactive scopes that are not necessary to bound downstream computation.
 * Specifically, the pass identifies the set of identifiers which are directly returned by
 * the function and/or transitively aliased by a return value - ie, values that "escape".
 *
 * Example to build intuition:
 *
 * ```javascript
 * function Component(props) {
 *   const a = {}; // not aliased or returned: *not* memoized
 *   const b = {}; // aliased by c, which is returned: memoized
 *   const c = [b]; // directly returned: memoized
 *   return c;
 * }
 * ```
 *
 * However, this logic alone is insufficient for two reasons:
 * - Statically memoizing JSX elements *may* be inefficient compared to using dynamic
 *   memoization with `React.memo()`. Static memoization may be JIT'd and can look at
 *   the precise props w/o dynamic iteration, but incurs potentially large code-size
 *   overhead. Dynamic memoization with `React.memo()` incurs potentially increased
 *   runtime overhead for smaller code size. We plan to experiment with both variants
 *   for JSX.
 * - Because we merge values whose mutations _interleave_ into a single scope, there
 *   can be cases where a non-escaping value needs to be memoized anyway to avoid breaking
 *   a memoization input. As a rule, for any scope that has a memoized output, all of that
 *   scope's transitive dependencies must also be memoized _even if they don't escape_.
 *   Failing to memoize them would cause the scope to invalidate more often than necessary
 *   and break downstream memoization.
 *
 * Example of this second case:
 *
 * ```javascript
 * function Component(props) {
 *   // a can be independently memoized but it doesn't escape, so naively we may think its
 *   // safe to not memoize. but not memoizing would break caching of b, which does
 *   // escape.
 *   const a = [props.a];
 *
 *   // b and c are interleaved and grouped into a single scope,
 *   // but they are independent values. c does not escape, but
 *   // we need to ensure that a is memoized or else b will invalidate
 *   // on every render since a is a dependency.
 *   const b = [];
 *   const c = {};
 *   c.a = a;
 *   b.push(props.b);
 *
 *   return b;
 * }
 * ```
 *
 * ## Algorithm
 *
 * 1. First we build up a graph, a mapping of IdentifierId to a node describing all the
 *    scopes and inputs involved in creating that identifier. Individual nodes are marked
 *    as definitely aliased, conditionally aliased, or unaliased:
 *      a. Arrays, objects, function calls all produce a new value and are always marked as aliased
 *      b. Conditional and logical expressions (and a few others) are conditinally aliased,
 *         depending on whether their result value is aliased.
 *      c. JSX is always unaliased (though its props children may be)
 * 2. The same pass which builds the graph also stores the set of returned identifiers.
 * 3. We traverse the graph starting from the returned identifiers and mark reachable dependencies
 *    as escaping, based on the combination of the parent node's type and its children (eg a
 *    conditional node with an aliased dep promotes to aliased).
 * 4. Finally we prune scopes whose outputs weren't marked.
 */
export function pruneNonEscapingScopes(
  fn: ReactiveFunction,
  options: MemoizationOptions
): void {
  // First build up a map of which instructions are involved in creating which values,
  // and which values are returned.
  const state = new State();
  if (fn.id !== null) {
    state.declare(fn.id.id);
  }
  for (const param of fn.params) {
    state.declare(param.identifier.id);
  }
  visitReactiveFunction(fn, new CollectDependenciesVisitor(options), state);

  log(() => prettyFormat(state));

  // Then walk outward from the returned values and find all captured operands.
  // This forms the set of identifiers which should be memoized.
  const memoized = computeMemoizedIdentifiers(state);

  log(() => prettyFormat(memoized));

  log(() => printReactiveFunction(fn));

  // Prune scopes that do not declare/reassign any escaping values
  visitReactiveFunction(fn, new PruneScopesTransform(), memoized);
}

export type MemoizationOptions = {
  memoizeJsxElements: boolean;
};

// Describes how to determine whether a value should be memoized, relative to dependees and dependencies
enum MemoizationLevel {
  // The value should be memoized if it escapes
  Memoized = "Memoized",
  // Values that are memoized if their dependencies are memoized (used for logical/ternary and
  // other expressions that propagate dependencies wo changing them)
  Conditional = "Conditional",
  // Values that cannot be compared with Object.is, but which by default don't need to be memoized
  // unless forced
  Unmemoized = "Unmemoized",
  // The value will never be memoized: used for values that can be cheaply compared w Object.is
  Never = "Never",
}

// Given an identifier that appears as an lvalue multiple times with different memoization levels,
// determines the final memoization level.
function joinAliases(
  kind1: MemoizationLevel,
  kind2: MemoizationLevel
): MemoizationLevel {
  if (
    kind1 === MemoizationLevel.Memoized ||
    kind2 === MemoizationLevel.Memoized
  ) {
    return MemoizationLevel.Memoized;
  } else if (
    kind1 === MemoizationLevel.Conditional ||
    kind2 === MemoizationLevel.Conditional
  ) {
    return MemoizationLevel.Conditional;
  } else if (
    kind1 === MemoizationLevel.Unmemoized ||
    kind2 === MemoizationLevel.Unmemoized
  ) {
    return MemoizationLevel.Unmemoized;
  } else {
    return MemoizationLevel.Never;
  }
}

// A node in the graph describing the memoization level of a given identifier as well as its dependencies and scopes.
type IdentifierNode = {
  level: MemoizationLevel;
  memoized: boolean;
  dependencies: Set<IdentifierId>;
  scopes: Set<ScopeId>;
  seen: boolean;
};

// A scope node describing its dependencies
type ScopeNode = {
  dependencies: Array<IdentifierId>;
  seen: boolean;
};

// Stores the identifier and scope graphs, set of returned identifiers, etc
class State {
  // Maps lvalues for LoadLocal to the identifier being loaded, to resolve indirections
  // in subsequent lvalues/rvalues
  definitions: Map<IdentifierId, IdentifierId> = new Map();

  identifiers: Map<IdentifierId, IdentifierNode> = new Map();
  scopes: Map<ScopeId, ScopeNode> = new Map();
  returned: Set<IdentifierId> = new Set();

  /**
   * Declare a new identifier, used for function id and params
   */
  declare(id: IdentifierId): void {
    this.identifiers.set(id, {
      level: MemoizationLevel.Never,
      memoized: false,
      dependencies: new Set(),
      scopes: new Set(),
      seen: false,
    });
  }

  /**
   * Associates the identifier with its scope, if there is one and it is active for the given instruction id:
   * - Records the scope and its dependencies
   * - Associates the identifier with this scope
   */
  visitOperand(
    id: InstructionId,
    place: Place,
    identifier: IdentifierId
  ): void {
    const scope = getPlaceScope(id, place);
    if (scope !== null) {
      let node = this.scopes.get(scope.id);
      if (node === undefined) {
        node = {
          dependencies: [...scope.dependencies].map((dep) => dep.identifier.id),
          seen: false,
        };
        this.scopes.set(scope.id, node);
      }
      const identifierNode = this.identifiers.get(identifier);
      invariant(
        identifierNode !== undefined,
        "Expected identifier to be initialized"
      );
      identifierNode.scopes.add(scope.id);
    }
  }
}

/**
 * Given a state derived from visiting the function, walks the graph from the returned nodes
 * to determine which other values should be memoized. Returns a set of all identifiers
 * that should be memoized.
 */
function computeMemoizedIdentifiers(state: State): Set<IdentifierId> {
  const memoized = new Set<IdentifierId>();

  // Visit an identifier, optionally forcing it to be memoized
  function visit(id: IdentifierId, forceMemoize: boolean = false): boolean {
    const node = state.identifiers.get(id);
    invariant(node !== undefined, "Expected a node for all identifiers");
    if (node.seen) {
      return node.memoized;
    }
    node.seen = true;

    // Note: in case of cycles we temporarily mark the identifier as non-memoized,
    // this is reset later after processing dependencies
    node.memoized = false;

    // Visit dependencies, determine if any of them are memoized
    let hasMemoizedDependency = false;
    for (const dep of node.dependencies) {
      const isDepMemoized = visit(dep);
      hasMemoizedDependency ||= isDepMemoized;
    }

    if (
      node.level === MemoizationLevel.Memoized ||
      (node.level === MemoizationLevel.Conditional &&
        (hasMemoizedDependency || forceMemoize)) ||
      (node.level === MemoizationLevel.Unmemoized && forceMemoize)
    ) {
      node.memoized = true;
      memoized.add(id);
      for (const scope of node.scopes) {
        forceMemoizeScopeDependencies(scope);
      }
    }
    return node.memoized;
  }

  // Force all the scope's optionally-memoizeable dependencies (not "Never") to be memoized
  function forceMemoizeScopeDependencies(id: ScopeId): void {
    const node = state.scopes.get(id);
    invariant(node !== undefined, "Expected a node for all scopes");
    if (node.seen) {
      return;
    }
    node.seen = true;

    for (const dep of node.dependencies) {
      visit(dep, true);
    }
    return;
  }

  // Walk from the "roots" aka returned identifiers.
  for (const returned of state.returned) {
    visit(returned);
  }

  return memoized;
}

type LValueMemoization = {
  place: Place;
  level: MemoizationLevel;
};

/**
 * Given a value, returns a description of how it should be memoized:
 * - lvalues: optional extra places that are lvalue-like in the sense of
 *   aliasing the rvalues
 * - rvalues: places that are aliased by the instruction's lvalues.
 * - level: the level of memoization to apply to this value
 */
function computeMemoizationInputs(
  value: ReactiveValue,
  lvalue: Place | null,
  options: MemoizationOptions
): {
  // can optionally return a custom set of lvalues per instruction
  lvalues: Array<LValueMemoization>;
  rvalues: Array<Place>;
} {
  switch (value.kind) {
    case "ConditionalExpression": {
      return {
        // Only need to memoize if the rvalues are memoized
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        rvalues: [
          // Conditionals do not alias their test value.
          ...computeMemoizationInputs(value.consequent, null, options).rvalues,
          ...computeMemoizationInputs(value.alternate, null, options).rvalues,
        ],
      };
    }
    case "LogicalExpression": {
      return {
        // Only need to memoize if the rvalues are memoized
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        rvalues: [
          ...computeMemoizationInputs(value.left, null, options).rvalues,
          ...computeMemoizationInputs(value.right, null, options).rvalues,
        ],
      };
    }
    case "SequenceExpression": {
      return {
        // Only need to memoize if the rvalues are memoized
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        // Only the final value of the sequence is a true rvalue:
        // values from the sequence's instructions are evaluated
        // as separate nodes
        rvalues: computeMemoizationInputs(value.value, null, options).rvalues,
      };
    }
    case "JsxExpression": {
      const operands: Array<Place> = [];
      operands.push(value.tag);
      for (const prop of value.props) {
        if (prop.kind === "JsxAttribute") {
          operands.push(prop.place);
        } else {
          operands.push(prop.argument);
        }
      }
      if (value.children !== null) {
        for (const child of value.children) {
          operands.push(child);
        }
      }
      const level = options.memoizeJsxElements
        ? MemoizationLevel.Memoized
        : MemoizationLevel.Unmemoized;
      return {
        // JSX elements themselves are not memoized unless forced to
        // avoid breaking downstream memoization
        lvalues: lvalue !== null ? [{ place: lvalue, level }] : [],
        rvalues: operands,
      };
    }
    case "JsxFragment": {
      const level = options.memoizeJsxElements
        ? MemoizationLevel.Memoized
        : MemoizationLevel.Unmemoized;
      return {
        // JSX elements themselves are not memoized unless forced to
        // avoid breaking downstream memoization
        lvalues: lvalue !== null ? [{ place: lvalue, level }] : [],
        rvalues: value.children,
      };
    }
    case "ComputedDelete":
    case "PropertyDelete":
    case "LoadGlobal":
    case "TemplateLiteral":
    case "Primitive":
    case "JSXText":
    case "BinaryExpression":
    case "UnaryExpression": {
      return {
        // All of these instructions return a primitive value and never need to be memoized
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Never }]
            : [],
        rvalues: [],
      };
    }
    case "TypeCastExpression": {
      return {
        // Indirection for the inner value, memoized if the value is
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        rvalues: [value.value],
      };
    }
    case "LoadLocal": {
      return {
        // Indirection for the inner value, memoized if the value is
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        rvalues: [value.place],
      };
    }
    case "DeclareLocal": {
      const lvalues = [
        { place: value.lvalue.place, level: MemoizationLevel.Unmemoized },
      ];
      if (lvalue !== null) {
        lvalues.push({ place: lvalue, level: MemoizationLevel.Unmemoized });
      }
      return {
        lvalues,
        rvalues: [],
      };
    }
    case "StoreLocal": {
      const lvalues = [
        { place: value.lvalue.place, level: MemoizationLevel.Conditional },
      ];
      if (lvalue !== null) {
        lvalues.push({ place: lvalue, level: MemoizationLevel.Conditional });
      }
      return {
        // Indirection for the inner value, memoized if the value is
        lvalues,
        rvalues: [value.value],
      };
    }
    case "Destructure": {
      // Indirection for the inner value, memoized if the value is
      const lvalues = [];
      if (lvalue !== null) {
        lvalues.push({ place: lvalue, level: MemoizationLevel.Conditional });
      }
      lvalues.push(...computePatternLValues(value.lvalue.pattern));
      return {
        lvalues: lvalues,
        rvalues: [value.value],
      };
    }
    case "ComputedLoad":
    case "PropertyLoad": {
      return {
        // Indirection for the inner value, memoized if the value is
        lvalues:
          lvalue !== null
            ? [{ place: lvalue, level: MemoizationLevel.Conditional }]
            : [],
        // Only the object is aliased to the result, and the result only needs to be
        // memoized if the object is
        rvalues: [value.object],
      };
    }
    case "ComputedStore": {
      // The object being stored to acts as an lvalue (it aliases the value), but
      // the computed key is not aliased
      const lvalues = [
        { place: value.object, level: MemoizationLevel.Conditional },
      ];
      if (lvalue !== null) {
        lvalues.push({ place: lvalue, level: MemoizationLevel.Conditional });
      }
      return {
        lvalues,
        rvalues: [value.value],
      };
    }
    case "OptionalCall":
    case "RegExpLiteral":
    case "FunctionExpression":
    case "TaggedTemplateExpression":
    case "CallExpression":
    case "ArrayExpression":
    case "NewExpression":
    case "ObjectExpression":
    case "MethodCall":
    case "PropertyStore": {
      // All of these instructions may produce new values which must be memoized if
      // reachable from a return value. Any mutable rvalue may alias any other rvalue
      const operands = [...eachReactiveValueOperand(value)];
      const lvalues = operands
        .filter((operand) => isMutableEffect(operand.effect))
        .map((place) => ({ place, level: MemoizationLevel.Memoized }));
      if (lvalue !== null) {
        lvalues.push({ place: lvalue, level: MemoizationLevel.Memoized });
      }
      return {
        lvalues,
        rvalues: operands,
      };
    }
    case "UnsupportedNode": {
      CompilerError.invariant(`Unexpected unsupported node`, value.loc);
    }
    default: {
      assertExhaustive(value, `Unexpected value kind '${(value as any).kind}'`);
    }
  }
}

function computePatternLValues(pattern: Pattern): Array<LValueMemoization> {
  const lvalues: Array<LValueMemoization> = [];
  switch (pattern.kind) {
    case "ArrayPattern": {
      for (const item of pattern.items) {
        if (item.kind === "Identifier") {
          lvalues.push({ place: item, level: MemoizationLevel.Conditional });
        } else {
          lvalues.push({ place: item.place, level: MemoizationLevel.Memoized });
        }
      }
      break;
    }
    case "ObjectPattern": {
      for (const property of pattern.properties) {
        if (property.kind === "ObjectProperty") {
          lvalues.push({
            place: property.place,
            level: MemoizationLevel.Conditional,
          });
        } else {
          lvalues.push({
            place: property.place,
            level: MemoizationLevel.Memoized,
          });
        }
      }
      break;
    }
    default: {
      assertExhaustive(
        pattern,
        `Unexpected pattern kind '${(pattern as any).kind}'`
      );
    }
  }
  return lvalues;
}

/**
 * Populates the input state with the set of returned identifiers and information about each
 * identifier's and scope's dependencies.
 */
class CollectDependenciesVisitor extends ReactiveFunctionVisitor<State> {
  options: MemoizationOptions;

  constructor(options: MemoizationOptions) {
    super();
    this.options = options;
  }

  override visitInstruction(
    instruction: ReactiveInstruction,
    state: State
  ): void {
    this.traverseInstruction(instruction, state);

    // Determe the level of memoization for this value and the lvalues/rvalues
    const aliasing = computeMemoizationInputs(
      instruction.value,
      instruction.lvalue,
      this.options
    );

    // Associate all the rvalues with the instruction's scope if it has one
    for (const operand of aliasing.rvalues) {
      const operandId =
        state.definitions.get(operand.identifier.id) ?? operand.identifier.id;
      state.visitOperand(instruction.id, operand, operandId);
    }

    // Add the operands as dependencies of all lvalues.
    for (const { place: lvalue, level } of aliasing.lvalues) {
      const lvalueId =
        state.definitions.get(lvalue.identifier.id) ?? lvalue.identifier.id;
      let node = state.identifiers.get(lvalueId);
      if (node === undefined) {
        node = {
          level: MemoizationLevel.Never,
          memoized: false,
          dependencies: new Set(),
          scopes: new Set(),
          seen: false,
        };
        state.identifiers.set(lvalueId, node);
      }
      node.level = joinAliases(node.level, level);
      // This looks like NxM iterations but in practice all instructions with multiple
      // lvalues have only a single rvalue
      for (const operand of aliasing.rvalues) {
        const operandId =
          state.definitions.get(operand.identifier.id) ?? operand.identifier.id;
        if (operandId === lvalueId) {
          continue;
        }
        node.dependencies.add(operandId);
      }

      state.visitOperand(instruction.id, lvalue, lvalueId);
    }

    if (instruction.value.kind === "LoadLocal" && instruction.lvalue !== null) {
      state.definitions.set(
        instruction.lvalue.identifier.id,
        instruction.value.place.identifier.id
      );
    }
  }

  override visitTerminal(
    stmt: ReactiveTerminalStatement<ReactiveTerminal>,
    state: State
  ): void {
    this.traverseTerminal(stmt, state);

    if (stmt.terminal.kind === "return" && stmt.terminal.value !== null) {
      state.returned.add(stmt.terminal.value.identifier.id);
    }
  }
}

/**
 * Prune reactive scopes that do not have any memoized outputs
 */
class PruneScopesTransform extends ReactiveFunctionTransform<
  Set<IdentifierId>
> {
  override transformScope(
    scope: ReactiveScopeBlock,
    state: Set<IdentifierId>
  ): Transformed<ReactiveStatement> {
    this.visitScope(scope, state);
    const hasMemoizedOutput =
      Array.from(scope.scope.declarations.keys()).some((id) => state.has(id)) ||
      Array.from(scope.scope.reassignments).some((identifier) =>
        state.has(identifier.id)
      );
    if (hasMemoizedOutput) {
      return { kind: "keep" };
    } else {
      return { kind: "replace-many", value: scope.instructions };
    }
  }
}

function isMutableEffect(effect: Effect): boolean {
  switch (effect) {
    case Effect.Capture:
    case Effect.Mutate:
    case Effect.Store: {
      return true;
    }
    default: {
      return false;
    }
  }
}
