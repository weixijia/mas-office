# Spec changes (RFCs)

Small, additive changes (a new optional field, a new event type that the reducer ignores) can be a normal pull request that updates `spec/README.md`, the JSON Schemas, both SDK reducers and a conformance case together.

Anything that changes the meaning of an existing field, an event rule, or the file layout needs an RFC:

1. Open a "Spec change" issue to check the idea.
2. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-name.md` (next free number) and open a pull request.
3. The RFC needs at least one conformance case and approval from two maintainers (see [GOVERNANCE.md](../../GOVERNANCE.md)). It stays open for at least 7 days.
4. When accepted, the spec version is bumped (minor for additive, major for breaking) and `CHANGELOG.md` records it.
