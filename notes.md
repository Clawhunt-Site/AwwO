# Implementation notes

Current reference snapshots: claude-obsidian 32ac5a02c4e082e4a5628ca810776375e134708e; OpenMausBot 104fd17b8f7767e71ba3cf40f27f9c6279b507bd.

The design adopts source preservation, traceable claims, reviewed atomic updates and scoped memory. It does not require wholesale upstream code or UI imports.

AwwO already provides team sequential/parallel/debate/review modes, tenant-scoped artifacts, isolated workspace execution and context budgeting. Artifact records have a canvas lifetime; knowledge storage must not inherit that lifetime.

Default Homebrew Node is broken (missing llhttp); use the bundled runtime after checking its version. Do not change host package configuration.
