import { useState } from "react";
import { useStore } from "../store/store";

export function SkillsView(): React.ReactElement | null {
  const skills = useStore((s) => s.skills);
  const configSkills = useStore((s) => s.config?.skills);
  const [open, setOpen] = useState(false);

  const source = skills.length > 0 ? skills : (configSkills ?? []);
  const list = source.map((s) => ({ name: s.name, description: s.description }));

  if (list.length === 0) return null;

  return (
    <div className="panel-section">
      <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">Skills</span>
        <span className="panel-count">{list.length}</span>
      </button>
      {open && (
        <ul className="skills-list">
          {list.map((skill) => (
            <li key={skill.name} className="skill-item">
              <span className="skill-name">{skill.name}</span>
              {skill.description && <span className="skill-desc">{skill.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
