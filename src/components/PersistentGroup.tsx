import { Group, useDefaultLayout, type GroupProps } from "react-resizable-panels";

/**
 * `Group` with its layout persisted to `localStorage`, replacing the
 * `autoSaveId` prop that react-resizable-panels dropped in v4. The hook has to
 * run at the top level of a component, so wrapping it here keeps the call sites
 * a one-for-one swap instead of threading `defaultLayout`/`onLayoutChanged`
 * through every group in the app.
 *
 * Saving is bound to `onLayoutChanged`, which the library only fires once a
 * pointer drag ends — so a resize writes to storage once rather than on every
 * pointer move.
 */
export function PersistentGroup({
  id,
  ...rest
}: GroupProps & { id: string }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    storage: localStorage,
  });
  return (
    <Group
      {...rest}
      id={id}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    />
  );
}
