# security/

Future home of Veltravia AI's security enforcement **code**:

- **policy engine** — approval gates that the self-development pipeline must pass
- **sandbox manager** — configuration and policy for isolated execution environments
- **secrets broker** — the single runtime accessor for external secrets
- **audit log** — append-only record of privileged actions and self-development attempts

The security _policy_ is already written: see [docs/security.md](../docs/security.md). This directory stays empty until the features it guards are built — security code that guards nothing rots.
