// The ways to support the project: More → Support and the
// welcome window list them. A way without a link yet shows as "soon".
// `logo`: its picture in public/logos (the sites' own marks, in their
// colours); without one, a plain drawn mark holds its place.

export interface SupportWay {
  id: string;
  name: string;
  /** A word on what it is. */
  sub: string;
  url: string;
  logo: string;
  /** What the logo sits on (one drawn for a light page). */
  tile?: string;
  /** The mark that stands in for the logo. */
  mark: string;
  /** A tag on the button's right (MakerWorld's Boost, with its rocket). */
  tag?: { icon: string; text: string };
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const SUPPORT: SupportWay[] = [
  {
    id: 'makerworld',
    name: 'MakerWorld',
    sub: 'Boost my models',
    url: 'https://makerworld.com/en/@supergeometry/upload',
    logo: 'logos/makerworld.png',
    tile: '#fff',
    tag: {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c2.6 2 4 5 4 8.5v5H8v-5c0-3.5 1.4-6.5 4-8.5z"/><path d="M8 12.5 5.5 15v3.5H8M16 12.5l2.5 2.5v3.5H16"/><circle cx="12" cy="9.5" r="1.6"/><path d="M10.5 19v2.5M13.5 19v2.5"/></svg>',
      text: 'Boost'
    },
    mark: svg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>')
  }
];

/** Opens in a new tab, with no way back into this page. */
export function openSupport(url: string): void {
  window.open(url, '_blank', 'noopener');
}
