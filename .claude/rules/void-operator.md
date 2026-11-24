# Void Operator

Avoid `void` operator in onClick handlers and callbacks.

When a function returns `undefined` or a Promise, don't wrap it with `void`. It's unnecessary noise.

```tsx
// ❌ Wrong
onClick={() => void submitVote('up')}
onClick={() => void handleClick()}

// ✅ Right
onClick={() => submitVote('up')}
onClick={() => handleClick()}
```

The only valid use of `void` is when you need to suppress a value at the type level, which is rare.
