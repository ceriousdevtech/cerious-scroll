# Contributing to Cerious Scroll™

Thank you for your interest in contributing to **Cerious Scroll™**. We appreciate your help in making this library better.

---

## Code of Conduct

By participating in this project, you agree to maintain a respectful and professional environment. We expect:

- Respectful communication
- Constructive feedback
- Focus on what's best for the project
- Empathy towards other contributors

---

## How Can I Contribute?

### Reporting Bugs

Before creating a bug report, please check the existing issues to avoid duplicates.

**Good Bug Reports include:**
- Clear, descriptive title
- Steps to reproduce the issue
- Expected vs. actual behavior
- Minimal code sample or live demo
- Browser, OS, and framework information
- Screenshots or videos if applicable

**Bug Report Template:**
```markdown
**Describe the bug**
A clear description of the issue.

**To Reproduce**
1. Initialize scroller with...
2. Scroll to...
3. Observe error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Environment**
- Cerious Scroll version:
- Browser:
- OS:
- Framework:

**Code Sample**
```js
// Minimal reproduction
```

**Additional context**
Any other relevant information.
```

---

### Suggesting Features

We welcome feature suggestions! Please:

- Check existing feature requests
- Clearly explain the use case
- Describe the user benefit
- Consider backward compatibility

**Feature Request Template:**
```markdown
**Problem / Use Case**
Describe the problem.

**Proposed Solution**
Describe your idea.

**Alternatives Considered**
Any alternatives explored.

**Additional Context**
Anything else relevant.
```

---

### Pull Requests

We welcome pull requests that align with the goals of the project.

**Before submitting:**
1. Fork the repository
2. Create a feature branch (`feature/your-feature`)
3. Make your changes
4. Add or update tests
5. Update documentation if needed
6. Ensure all tests pass
7. Commit with clear messages

**PR Guidelines:**
- One feature or fix per PR
- Follow existing code style
- Include tests for new behavior
- Keep commits atomic and well-described

---

## Development Setup

### Prerequisites
- Node.js 18+
- npm
- Git

### Setup

```bash
git clone https://github.com/ceriousdevtech/cerious-scroll.git
cd cerious-scroll
npm install
npm test
npm run build
```

---

## Project Structure

```
cerious-scroll/
├── src/                     # Source code
│   ├── cerious-scroll.ts    # Main class
│   ├── index.ts             # Public exports
│   ├── controllers/         # Input controllers (wheel, touch, keyboard, resize)
│   ├── core/                # Core functionality (cache, state, events)
│   ├── engine/              # Navigation engine and boundary guardian
│   ├── features/            # Feature implementations (scrollbar, renderer)
│   ├── observers/           # Content observers
│   ├── types/               # TypeScript type definitions
│   └── utils/               # Utility functions
├── tests/                   # Test files (mirrors src structure)
│   ├── controllers/
│   ├── core/
│   ├── engine/
│   ├── helpers/
│   └── integration/
├── index.html               # Demo gallery / GitHub Pages landing
├── *-demo.html              # Individual demos
├── demo-bootstrap.js
├── shared-styles.css
├── docs/                    # Documentation
│   ├── ARCHITECTURE.md      # Technical architecture docs
│   └── IMPLEMENTATION_GUIDE.md  # Integration guide
├── dist/                    # Build output (compiled files)
├── .github/                 # GitHub workflows and actions
│   └── workflows/
│       └── deploy-pages.yml
├── README.md                # User-facing documentation
├── CHANGELOG.md             # Version history
├── CONTRIBUTING.md          # This file
├── SECURITY.md              # Security policy
├── LICENSE                  # MIT license text
├── LICENSE-MIT              # MIT license text (duplicate for convenience)
├── package.json             # NPM configuration
└── vitest.config.ts         # Test configuration
```

---

## Testing

```bash
npm test
```

That is `vitest run`. After source changes, rebuild the bundle (`npm run compile && npm run bundle`) or the HTML demos will keep serving the old IIFE.

---

## Code Style

- TypeScript strict mode
- No `any` in public APIs
- JSDoc for public methods
- Explain *why*, not *what*

---

## Legal Considerations

### License
Cerious Scroll™ is licensed under the **MIT License**.

All contributions must be compatible with the MIT license.

---

### Contributor License Agreement (CLA)

By submitting a pull request, issue, or other contribution, you acknowledge and agree that:

- You have the legal right to submit the contribution
- The contribution is your original work or you have permission to submit it
- You grant **Cerious DevTech LLC** a perpetual, worldwide, irrevocable,
  royalty-free right to use, modify, sublicense, and redistribute your
  contribution as part of Cerious Scroll™ under the MIT license.

This agreement applies automatically upon submission.
No additional signature is required.

---

## Getting Help

- GitHub Issues for bugs
- GitHub Discussions for questions
- Email: info@ceriousdevtech.com

---

## Recognition

Significant contributors may be recognized in release notes and changelogs.

---

## Copyright

Copyright © 2024–2026  
**Cerious DevTech LLC**  
All rights reserved.
