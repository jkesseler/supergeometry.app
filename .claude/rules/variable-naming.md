---
paths:
  - "**/*.{ts,tsx}"
---

# Naming Rules

## Basics

- Use English
- Use `camelCase` consistently
- No contractions: `onItemClick` not `onItmClk`
- Avoid duplicating context: `MenuItem.handleClick()` not `handleMenuItemClick()`
- Match the name to the result: `isDisabled` not `isEnabled` when checking `disabled={isDisabled}`

## Variables

Prefix with boolean indicator:
- `is` + adjective: `isBlue`, `isPresent`
- `has` + noun: `hasProducts`
- `should` + verb: `shouldUpdate`

Boundaries/state:
- `min`, `max`, `prev`, `next`

Singular for single value, plural for collections:
- `friend = 'Bob'`
- `friends = ['Bob', 'Tony']`

## Functions

Pattern: `<prefix?><action><context>`

### Actions

- `get`: access data (sync or async)
- `set`: assign value
- `reset`: restore to initial state
- `compose`: create new data from existing
- `handle`: respond to action/event
- `remove`: delete from collection
- `delete`: erase completely

### Prefixes

- `should`: conditional statement before action
- `is`, `has`: boolean properties

## Short, Intuitive, Descriptive

- Choose readable names over brevity
- Use real words, avoid made-up verbs
- Reflect what it does/means
