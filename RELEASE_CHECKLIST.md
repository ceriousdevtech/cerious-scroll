# CeriousScroll Release Checklist

Use this checklist before releasing a new version of CeriousScroll.

---

## Pre-Release Checklist

### 1. Code Quality ✓

- [ ] All tests passing: `npm test`
- [ ] No TypeScript errors: `npm run compile`
- [ ] Code follows style guidelines
- [ ] All TODO comments addressed or documented
- [ ] No console.log or debug code in production files
- [ ] Performance benchmarks run and verified

### 2. Documentation ✓

- [ ] README.md updated with new features
- [ ] CHANGELOG.md updated with all changes
- [ ] API documentation updated (if API changed)
- [ ] IMPLEMENTATION_GUIDE.md updated (if needed)
- [ ] ARCHITECTURE.md updated (if architectural changes)
- [ ] Code examples tested and working
- [ ] Demos updated to showcase new features

### 3. Version Management ✓

- [ ] Version bumped in `package.json` (following semver)
- [ ] Version matches in CHANGELOG.md
- [ ] Release notes drafted
- [ ] Breaking changes documented (if major version)
- [ ] Migration guide written (if major version)

### 4. Build & Distribution ✓

- [ ] Clean build: `rm -rf dist && npm run build`
- [ ] Built files verified in `dist/` directory:
  - [ ] `cerious-scroll.js` (ES module)
  - [ ] `cerious-scroll.d.ts` (TypeScript definitions)
  - [ ] `cerious-scroll.bundle.js` (IIFE bundle)
  - [ ] `cerious-scroll.min.js` (Minified)
  - [ ] `cerious-scroll.obfuscated.js` (Obfuscated)
  - [ ] Source maps present
- [ ] File sizes reasonable (no unexpected bloat)
- [ ] Minified version works in browsers
- [ ] No sensitive information in built files

### 5. Testing ✓

#### Unit Tests
- [ ] All unit tests passing
- [ ] Test coverage adequate (>80%)
- [ ] Edge cases covered

#### Integration Tests
- [ ] All integration tests passing
- [ ] Framework integrations tested (Vue, Angular)

#### Browser Testing
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)
- [ ] Mobile Safari (iOS)
- [ ] Chrome Mobile (Android)

#### Demo Testing
- [ ] All demos load without errors
- [ ] Scrolling smooth in all demos
- [ ] No console errors in demos
- [ ] Performance acceptable in all demos

### 6. Legal & Licensing ✓

- [ ] License files up to date (LICENSE, LICENSE-MIT)
- [ ] Copyright year current in all files
- [ ] No license violations in dependencies: `npm audit`

### 7. Dependencies ✓

- [ ] Dependencies up to date: `npm outdated`
- [ ] Security vulnerabilities checked: `npm audit`
- [ ] No unnecessary dependencies
- [ ] Peer dependencies documented
- [ ] DevDependencies separated from dependencies

### 8. Package Configuration ✓

- [ ] package.json fields complete:
  - [ ] name, version, description
  - [ ] main, module, types fields correct
  - [ ] keywords relevant
  - [ ] repository URL correct
  - [ ] bugs URL correct
  - [ ] homepage URL correct
  - [ ] license correct
  - [ ] author information correct
- [ ] .npmignore configured correctly
- [ ] Files array in package.json correct

### 9. GitHub Preparation ✓

- [ ] All changes committed
- [ ] Working directory clean: `git status`
- [ ] On correct branch (usually `main`)
- [ ] Branch up to date: `git pull origin main`
- [ ] GitHub Issues addressed or documented
- [ ] Pull requests merged

---

## Release Process

### Step 1: Create Release Branch

```bash
git checkout -b release/v1.0.0
```

### Step 2: Update Version

```bash
# Update version in package.json
npm version <major|minor|patch> --no-git-tag-version

# Update CHANGELOG.md with release date
# Update any version references in documentation
```

### Step 3: Final Verification

```bash
# Clean install
rm -rf node_modules package-lock.json
npm install

# Run all checks
npm test
npm run build

# Verify built files
ls -lh dist/
```

### Step 4: Commit Release

```bash
git add .
git commit -m "chore: release v1.0.0"
git push origin release/v1.0.0
```

### Step 5: Create Pull Request

- Create PR to main branch
- Get approval from maintainer(s)
- Merge to main

### Step 6: Tag Release

```bash
git checkout main
git pull origin main
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

### Step 7: Create GitHub Release

1. Go to GitHub repository
2. Click "Releases" → "Draft a new release"
3. Select the tag (v1.0.0)
4. Release title: "CeriousScroll v1.0.0"
5. Copy release notes from CHANGELOG.md
6. Attach built files (optional):
   - `cerious-scroll.min.js`
   - `cerious-scroll.obfuscated.js`
7. Mark as pre-release if applicable
8. Publish release

### Step 8: Publish to NPM

```bash
# Login to npm (if not already)
npm login

# Dry run to verify what will be published
npm publish --dry-run

# Publish to npm
npm publish

# For pre-release versions:
npm publish --tag beta
```

### Step 9: Verify NPM Package

```bash
# Install from npm in a test project
mkdir test-install
cd test-install
npm init -y
npm install @ceriousdevtech/cerious-scroll

# Verify files are correct
ls node_modules/@ceriousdevtech/cerious-scroll/
```

### Step 10: Update Documentation Site

```bash
# If using GitHub Pages, push will auto-deploy
git push origin main

# Verify site updates at:
# https://ceriousdevtech.github.io/cerious-scroll/
```

### Step 11: Announce Release

- [ ] Tweet announcement (if applicable)
- [ ] Post on relevant forums/communities
- [ ] Update company website
- [ ] LinkedIn post (if applicable)

---

## Post-Release Checklist

### Immediate (Same Day)

- [ ] Verify npm package is available: `npm view @ceriousdevtech/cerious-scroll`
- [ ] Test installation in clean project
- [ ] Monitor for immediate issues
- [ ] Respond to any urgent bug reports

### Within 24 Hours

- [ ] Check download stats on npm
- [ ] Monitor GitHub issues for problems
- [ ] Update internal documentation

### Within 1 Week

- [ ] Review community feedback
- [ ] Address any critical bugs with patch release
- [ ] Update project roadmap
- [ ] Plan next release

---

## Rollback Procedure

If critical issues are discovered after release:

### Option 1: Quick Patch

```bash
# Create hotfix branch
git checkout -b hotfix/v1.0.1 v1.0.0

# Fix the issue
# ... make changes ...

# Release patch version
npm version patch
git commit -am "fix: critical bug in xxx"
git push origin hotfix/v1.0.1

# Merge to main and tag
git checkout main
git merge hotfix/v1.0.1
git tag v1.0.1
git push origin main --tags

# Publish patch
npm publish
```

### Option 2: Deprecate Version

```bash
# Deprecate problematic version
npm deprecate @ceriousdevtech/cerious-scroll@1.0.0 "Critical bug, please upgrade to 1.0.1"
```

### Option 3: Unpublish (Within 72 hours only)

```bash
# Last resort - only if absolutely necessary
npm unpublish @ceriousdevtech/cerious-scroll@1.0.0
```

---

## Version Strategy

### Semantic Versioning

- **Major (X.0.0)**: Breaking changes
- **Minor (0.X.0)**: New features, backwards compatible
- **Patch (0.0.X)**: Bug fixes, backwards compatible

### Pre-release Versions

- **Alpha**: `1.0.0-alpha.1` - Early testing, unstable
- **Beta**: `1.0.0-beta.1` - Feature complete, testing phase
- **RC**: `1.0.0-rc.1` - Release candidate, final testing

---

## Emergency Contact

If issues arise during release:

**Primary Contact:** info@ceriousdevtech.com  
**Emergency:** Jared Kirchgatter

---

## Notes

- Always test in production-like environment before release
- Keep communication transparent with users
- Document any deviations from this checklist
- Update this checklist as process evolves

---

**Last Updated:** 2026-01-28  
**Version:** 1.0.0

---

Copyright © 2024-2026 Cerious DevTech LLC. All rights reserved.
