# Test IDs

Playwright tests select elements by `data-testid`. The site has several
locales and its labels and links come from the CMS, so selectors on text,
accessible names or content break when an editor or translator changes them.

```ts
// ❌ Wrong
page.getByRole('button', { name: 'Onze producten' });
panel.getByRole('link', { name: 'Schoonmaakartikelen' });

// ✅ Right
page.getByTestId('products-button');
panel.getByTestId('store-view').first();
```

- When a test needs an element without a `data-testid`, add one to the component.
- Name it in kebab-case after what the element is, not how it looks: `products-panel`, not `white-dropdown`.
- One id per kind of element. Repeated elements share an id; pick one with `.first()`, `.nth()` or `.filter()`.
- `getByTestId` also matches hidden elements, unlike `getByRole`. Add `.filter({ visible: true })` when hidden copies exist.
- Content from the CMS that a component cannot tag (for example a link rendered by `CmsLink`): scope to the nearest test id and select by a stable attribute such as `href^="tel:"`, never by its text.
