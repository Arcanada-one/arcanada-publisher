// Reddit "thing" fullnames: every object carries a type-prefixed id.
//   t1_<id>  comment
//   t3_<id>  link (post)
//   t5_<id>  subreddit
// The `/api/comment` endpoint's `parent` field is a fullname: a reply TO a
// comment uses `t1_<commentId>`; a top-level comment ON a post uses
// `t3_<postId>`. Getting this prefix right is the V-AC-12 oracle.

export type ThingKind = "comment" | "post" | "subreddit";

const KIND_PREFIX: Record<ThingKind, string> = {
  comment: "t1_",
  post: "t3_",
  subreddit: "t5_",
};

/** Build a Reddit fullname for an id of a given kind (e.g. comment → t1_abc). */
export function fullname(kind: ThingKind, id: string): string {
  if (!id) {
    throw new Error(`fullname: empty id for kind '${kind}'`);
  }
  const prefix = KIND_PREFIX[kind];
  // Idempotent: if the id is already a fullname of this kind, return as-is.
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

/** The parent fullname for a comment reply. */
export function commentParent(kind: "comment" | "post", id: string): string {
  return fullname(kind, id);
}

/** True when a fullname denotes a comment (t1_). */
export function isCommentFullname(name: string): boolean {
  return name.startsWith("t1_");
}

/** True when a fullname denotes a post/link (t3_). */
export function isPostFullname(name: string): boolean {
  return name.startsWith("t3_");
}
