export type ProjectNameValidationReason =
  | "required"
  | "single_folder_name"
  | "null_character"
  | "component_too_long";

export type ProjectNameValidation =
  | { kind: "ok" }
  | {
      kind: "hard" | "safe";
      reason: ProjectNameValidationReason;
      message: string;
    };

export function validateProjectName(name: string): ProjectNameValidation {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      kind: "hard",
      reason: "required",
      message: "Project name is required.",
    };
  }
  if (trimmed.includes("\0")) {
    return {
      kind: "hard",
      reason: "null_character",
      message: "Project name cannot contain a null character.",
    };
  }
  if (trimmed === "." || trimmed === "..") {
    return {
      kind: "hard",
      reason: "single_folder_name",
      message: "Project name must be a single folder name.",
    };
  }
  if (trimmed.includes("/")) {
    return {
      kind: "hard",
      reason: "single_folder_name",
      message: "Project name must be a single folder name.",
    };
  }

  const safe = validateProjectNameSafety(trimmed);
  return safe ?? { kind: "ok" };
}

function validateProjectNameSafety(
  name: string,
): Exclude<ProjectNameValidation, { kind: "ok" }> | null {
  if (new TextEncoder().encode(name).length > 255) {
    return {
      kind: "safe",
      reason: "component_too_long",
      message:
        "Project name is longer than 255 bytes, which common filesystems reject.",
    };
  }
  return null;
}
