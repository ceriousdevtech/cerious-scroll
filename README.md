# Cerious Scroll™

[![License](https://img.shields.io/badge/license-MIT%20%7C%20Commercial-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/%40ceriousdevtech%2Fcerious-scroll.svg)](https://www.npmjs.com/package/@ceriousdevtech/cerious-scroll)
[![Patent Pending](https://img.shields.io/badge/patent-pending-orange.svg)](LICENSE)

**High-Performance Virtual Scrolling for Web Applications**

Cerious Scroll™ is an enterprise-grade virtual scrolling engine that enables smooth scrolling through **millions to hundreds of millions of elements** at a consistent **60 FPS+**, while maintaining **O(1) constant memory usage**.

It is designed for data grids, chat applications, log viewers, financial dashboards, analytics platforms, and any application that must efficiently render massive datasets without performance degradation.

🌐 **[View Live Demos](https://ceriousdevtech.github.io/cerious-scroll/)** | 📚 **[Read Documentation](https://ceriousdevtech.github.io/cerious-scroll/docs/IMPLEMENTATION_GUIDE.html)**

---

## 🚀 Key Features

- **True O(1) Memory Usage**  
  Constant memory regardless of dataset size (tested with 100M+ elements)

- **Consistent 60 FPS+ Performance**  
  Sub-millisecond scroll calculations under real-world load

- **Native Variable Height Support**  
  No pre-calculation required — automatic, on-demand measurement

- **Framework Agnostic**  
  Works with Vanilla JS, Angular, React, Vue, or any framework

- **Native Scrollbar Integration**  
  Familiar UX with accurate bidirectional synchronization

- **Element-Based Positioning Algorithm**  
  Eliminates fragile pixel-math approaches

- **No GPU Transforms**  
  Pure DOM manipulation — no `translate3d` hacks

- **TypeScript Support**  
  Full type definitions included

---

## 📦 Installation

### npm
```bash
npm install @ceriousdevtech/cerious-scroll
```

### From Source
```bash
# Clone the repository
git clone https://github.com/ceriousdevtech/cerious-scroll.git
cd cerious-scroll

# Install dependencies and build
npm install
npm run build

# Use the built files from dist/
```

### Direct Download
Download the latest release from [GitHub Releases](https://github.com/ceriousdevtech/cerious-scroll/releases) and include:
```html
<script src="path/to/cerious-scroll.bundle.js"></script>
```

Or via CDN:
```html
<script src="https://unpkg.com/@ceriousdevtech/cerious-scroll@latest/dist/cerious-scroll.min.js"></script>
```

---

## 🎯 Quick Start

```javascript
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const data = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  content: `Item ${i}`
}));

const container = document.getElementById('scroll-container');

const scroller = new CeriousScroll(
  container,
  data.length,
  40
);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      element.innerHTML = `<div class="item">${data[index].content}</div>`;
      return element.offsetHeight;
    }
  );
});

container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
```

---

## 📄 License

Cerious Scroll™ is **dual-licensed** by **Cerious DevTech LLC**.

### Open-Source License
- **MIT License** (see LICENSE or LICENSE-MIT)

### Commercial License
Available for organizations that prefer a separately executed commercial agreement
(for example: explicit patent rights, priority support, or custom terms).

See LICENSE-COMMERCIAL for details.

📧 **info@ceriousdevtech.com**

---

## 🔒 Patent Status

**Patent Pending**  
U.S. Provisional Patent Application filed by **Cerious DevTech LLC**, October 2025.

---

## 🤝 Contributing

By submitting a pull request, you agree to the **Contributor License Agreement (CLA)**.

---

## 📜 Copyright

Copyright © 2024–2026  
**Cerious DevTech LLC**  
All rights reserved.
