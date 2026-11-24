import { useEffect, useState } from 'preact/hooks';
import type { DocStore } from '../doc/store';
import type { ProjectDoc } from '../doc/types';

/** The project as it is now; the component draws again whenever it changes. */
export function useDocStore(store: DocStore): ProjectDoc {
  const [doc, setDoc] = useState(store.doc);

  useEffect(() => {
    setDoc(store.doc);

    return store.onChange(() => setDoc(store.doc));
  }, [store]);

  return doc;
}
