
// Toggle theme

const localTheme = window.localStorage && window.localStorage.getItem("theme");
const themeToggle = document.querySelector("#theme-toggle");

if (localTheme) {
    document.body.classList.remove("light", "dark");
    document.body.classList.add(localTheme);
}

themeToggle.addEventListener("click", () => {
    const themeUndefined = !new RegExp("(dark|light)-theme").test(document.body.className);
    const isOSDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    if (themeUndefined) {
        if (isOSDark) {
            document.body.classList.add("light");
        } else {
            document.body.classList.add("dark");
        }
    } else {
        document.body.classList.toggle("light");
        document.body.classList.toggle("dark");
    }

    window.localStorage &&
        window.localStorage.setItem(
            "theme",
            document.body.classList.contains("dark") ? "dark" : "light",
        );
});