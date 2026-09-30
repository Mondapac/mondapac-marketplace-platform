# verticals

Vertical implementations of the core extension points (ADR-0001, ADR-0008) live in
`verticals/<vertical>/`. Core code (`modules/`, `platform/`, `shared-kernel`) must never import
from here; verticals register themselves through the extension-point registry. Empty in the
Phase 1 skeleton.
