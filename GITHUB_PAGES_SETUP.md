# CeriousScroll GitHub Pages Setup

## 🌐 Live Site

Once deployed, your GitHub Pages site will be available at:
- `https://ceriousdevtech.github.io/cerious-scroll/`

## 📁 Structure

```
/
├── index.html                      # Main landing page
├── docs/
│   ├── ARCHITECTURE.html          # Architecture documentation (auto-generated)
│   └── IMPLEMENTATION_GUIDE.html  # Implementation guide (auto-generated)
├── demo/
│   ├── vanilla-js-demo.html
│   ├── data-grid-demo.html
│   ├── chat-messaging-demo.html
│   └── ... (all other demos)
└── dist/                          # Built library files
```

## 🚀 Deployment

### Automatic Deployment (Recommended)

The site automatically deploys to GitHub Pages when you push to the `main` branch using GitHub Actions.

**Setup Steps:**

1. **Enable GitHub Pages in your repository:**
   - Go to your repository on GitHub
   - Navigate to Settings → Pages
   - Under "Build and deployment":
     - Source: Select "GitHub Actions"
   - Save

2. **Push your code:**
   ```bash
   git add .
   git commit -m "Setup GitHub Pages"
   git push origin main
   ```

3. **Wait for deployment:**
   - Go to the "Actions" tab in your repository
   - Watch the "Deploy to GitHub Pages" workflow run
   - Once complete (green checkmark), your site is live!

### Manual Deployment

If you prefer manual deployment:

1. Build the project:
   ```bash
   npm run build
   ```

2. Create a `gh-pages` branch and push the built files

## 📝 Customization

### Update Repository URL

In `index.html`, update the GitHub link:
```html
<a href="https://github.com/ceriousdevtech/cerious-scroll">GitHub</a>
```

### Modify Landing Page

Edit `index.html` to customize:
- Branding and colors
- Feature descriptions
- Demo links
- Contact information

### Update Documentation

Edit the markdown files in the `docs/` folder:
- `docs/ARCHITECTURE.md` - Technical architecture
- `docs/IMPLEMENTATION_GUIDE.md` - Integration guide

Changes will automatically be converted to HTML during deployment.

## 🎨 Styling

The landing page uses:
- Responsive grid layout
- Gradient backgrounds
- Card-based design
- Mobile-friendly navigation

Customize colors by changing the CSS variables in `index.html`.

## 🔧 Troubleshooting

### Site not deploying?

1. Check the Actions tab for error messages
2. Ensure GitHub Pages is enabled in Settings
3. Verify the workflow file is in `.github/workflows/`

### 404 errors on demo pages?

Ensure all demo files are committed and pushed to the repository.

### Styling issues?

Clear your browser cache or use incognito mode to see changes.

## 📊 Analytics (Optional)

To add Google Analytics, insert this in the `<head>` of `index.html`:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>
```

Replace `GA_MEASUREMENT_ID` with your actual Google Analytics ID.

## 🔒 Custom Domain (Optional)

To use a custom domain:

1. Add a `CNAME` file to the repository root:
   ```
   cerious-scroll.com
   ```

2. Configure your domain's DNS settings to point to GitHub Pages

3. Enable HTTPS in GitHub Pages settings

## 📞 Support

For issues with GitHub Pages setup, contact: info@ceriousdevtech.com

## License

All documentation and demo files are subject to the MIT License.
