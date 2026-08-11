const express = require("express");
const path = require("path");
const projectRoutes = require("./routes/projects");
const runRoutes = require("./routes/runs");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.use("/projects", projectRoutes);
app.use("/", runRoutes); // mounts /projects/:projectId/runs and /runs/:id

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Loc Toolkit API listening on http://localhost:${PORT}`);
});
