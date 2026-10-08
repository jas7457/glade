/** Copy buttons: `data-copy="<id>"` copies that element's text (the build commands). */
export function initCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const target = document.getElementById(button.dataset.copy ?? "");
    if (!target) continue;
    const label = button.textContent;
    let timer = 0;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(target.innerText.trim() + "\n");
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      clearTimeout(timer);
      timer = window.setTimeout(() => (button.textContent = label), 1600);
    });
  }
}
