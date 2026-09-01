# Pi Fabric design adoption

This branch experiments with the parts of `pi-fabric` that fit agent-pi's
extension-first architecture. The goal is to improve composition and
observability without replacing the existing task, approval, security, and
worker lifecycle boundaries.

## Adopted in this iteration

- Every tool registered through `registerToolWithExecutor` publishes a
  namespaced `extensions.<tool>` capability descriptor.
- Descriptors carry an input schema, inferred or explicit risk, and a coarse
  effect/resource declaration. This gives discovery, approval, and future UI a
  shared vocabulary.
- `compose_exec` executes registered extension capabilities in sequence or in
  parallel, caps a batch at 16 steps, blocks meta-tool recursion, and reuses
  the existing nested security and approval gates.
- Nested arguments are validated against the registered capability schema before
  execution, and parallel batches are rejected when non-commutative effects
  share a resource.
- Composition returns bounded structured step results instead of forwarding
  every intermediate tool payload.

## Deliberately deferred

- QuickJS guest execution: the first composition surface is host-side and only
  runs already registered extension handlers.
- Built-in Pi tool proxying: built-ins continue through Pi's native path until
  their schemas and executors can be exposed through the same registry.
- Actors, councils, recursive workers, and a cross-process topology: the
  existing journal, mailbox, evidence, and worker lifecycle need a shared
  `RunContext` first.

## Next validation gates

1. Add a shared run id, total token/cost budget, and event stream around TEAM,
   CHAIN, and PIPELINE dispatch.
2. Exercise `compose_exec` with mocked extension handlers and approval/security
   rejection cases before exposing more capabilities.
