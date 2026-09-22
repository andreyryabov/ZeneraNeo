---
requires: [files]
---

# Working with files

These rules govern how files are discovered, inspected, and modified. If file tools
are not among your tools, you cannot read or change files directly.

## Access modes

Check which tools you actually have:

- If `write_file` or `apply_patch` is not among your tools, your access is **read-only**.
  Inspect files, search directories, and report conclusions, but attempt no edits.
- If `write_file` and `apply_patch` are available, you may create and edit files
  under `/workspace`.

## Discovery before assumption

Never guess a file's name, location, or contents.

- Use `list_dir` to see directory contents and formats before opening files.
- Use `find_files` to locate files by substring when the layout is unfamiliar.
- Check whether a target file already exists before writing to it.

## Reading files

- Use `read_file` to read text files.
- For files longer than a few dozen lines, pass `start_line` and `end_line` (1-based, inclusive)
  to read only the relevant section.
- When `read_file` returns `truncated: true`, the read hit the size limit or range boundary.
  Resume reading from `end_line + 1` if you need the remainder.
- Non-text files (images, binaries, archives) cannot be read as text; `list_dir` reports
  their format.

## Modifying files

### Modifying existing files: `apply_patch`

Always use `apply_patch` to edit existing files. It makes surgical, verifiable changes
and validates the entire patch before writing any file to disk.

1. **Read before patching**: Read the target file first to obtain exact context lines.
   An outdated or imagined context line fails the patch.
2. **Provide context**: Include at least 3 unchanged context lines (prefixed with a space)
   before and after each change.
3. **No line numbers**: Patches match on context text, never on line numbers.
4. **Always close the patch**: Every patch must begin with `*** Begin Patch` and end
   with `*** End Patch`. Omitting `*** End Patch` is an error.

Example patch:

```
*** Begin Patch
*** Update File: /workspace/src/config.ts
@@ port configuration
 export interface Config {
     host: string;
-    port: 80;
+    port: 8080;
     timeoutMs: number;
 }
*** End Patch
```

### Creating new files: `write_file`

Use `write_file` only to create a **new** file or to overwrite a small file completely.
Never use `write_file` to update an existing file when only a few lines need to change.

### Moving and deleting

- Use `move_file` to rename or relocate a file or directory. It creates parent directories
  as needed. Set `overwrite: true` only when intentionally replacing an existing destination.
- Use `delete_file` to remove a file. Removing a directory requires `recursive: true`.

## Mounts and containment

All file operations are confined to mounted trees:

- `/workspace`: The primary writable directory for the project. Paths inside the workspace
  (such as `/workspace/src/main.ts`) are where project files reside.
- `/assets`, `/skills`, `/memory`: Read-only mounts. You may read, list, and search them,
  but you cannot write, move, or delete files inside them.
- Any attempt to reach outside these mounts fails with an containment error.
