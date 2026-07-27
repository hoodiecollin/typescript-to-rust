import dedent from "dedent";

/**
 * Dedent helper for authoring multi-line content strings — markdown/MDX copy or
 * code samples — as clean template literals. Lets every string in the content
 * modules be written inline and multi-line, with no `+` concatenation and no
 * `.join("\n")`.
 */
export const dd = dedent.withOptions({ alignValues: true });

export default dd;
