/**
 * The two Monaco internals `src/lib/editorMenu.ts` reaches into.
 *
 * `monaco-editor` ships types only for its public entry: the exports map sends every other
 * subpath at the bare `.js`, so these have to be declared by hand. Each shape below is the slice
 * this app actually calls, read off the module it stands for — `MenuRegistry.appendMenuItem` and
 * `CommandsRegistry.registerCommand` both hand back a disposable this app never needs, because
 * the registrations live as long as the bundle does.
 */
declare module "monaco-editor/platform/actions/common/actions" {
  /**
   * What a menu entry calls itself. Monaco reads this when it builds a menu, and takes `.value`
   * from anything that is not already a string (`actions.js:424`) — which is the seam that lets a
   * label be looked up per opening instead of frozen at bundle load.
   */
  type IMenuTitle = string | { value: string };

  interface IMenuCommand {
    id: string;
    title: IMenuTitle;
    /** A context-key expression; `undefined` means the item is always offered. */
    precondition?: unknown;
  }

  interface IMenuItem {
    command?: IMenuCommand;
    /** A submenu entry names itself here rather than through a command. */
    title?: IMenuTitle;
    submenu?: unknown;
    /** Menu items are grouped, and groups are ordered by name; `9_cutcopypaste` is Monaco's own. */
    group?: string;
    order?: number;
    when?: unknown;
  }

  export const MenuId: {
    readonly EditorContext: unique symbol;
    readonly SimpleEditorContext: unique symbol;
    readonly CommandPalette: unique symbol;
  };

  export const MenuRegistry: {
    appendMenuItem(
      menuId: typeof MenuId.EditorContext,
      item: IMenuItem
    ): { dispose(): void };
    /** The array is new on every call; the entries inside it are the stored ones. */
    getMenuItems(menuId: typeof MenuId.EditorContext): IMenuItem[];
  };
}

declare module "monaco-editor/platform/commands/common/commands" {
  export const CommandsRegistry: {
    /** Registering an id that is already taken puts this handler at the head of the list. */
    registerCommand(
      id: string,
      handler: (accessor: unknown, ...args: unknown[]) => unknown
    ): { dispose(): void };
    getCommand(id: string): unknown;
  };
}
