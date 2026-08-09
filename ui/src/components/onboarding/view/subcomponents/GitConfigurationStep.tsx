import { GitBranch, Mail, User } from "lucide-react";

type GitConfigurationStepProps = {
  gitName: string;
  gitEmail: string;
  isSubmitting: boolean;
  onGitNameChange: (value: string) => void;
  onGitEmailChange: (value: string) => void;
};

export default function GitConfigurationStep({
  gitName,
  gitEmail,
  isSubmitting,
  onGitNameChange,
  onGitEmailChange,
}: GitConfigurationStepProps) {
  return (
    <div className="space-y-6">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900/30">
          <GitBranch className="h-8 w-8 text-brand-600 dark:text-brand-400" />
        </div>
        <h2 className="mb-2 text-2xl font-bold text-foreground">Git Configuration</h2>
        <p className="text-muted-foreground">Configure your git identity to ensure proper attribution for commits.</p>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="gitName" className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <User className="h-4 w-4" />
            Git Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="gitName"
            value={gitName}
            onChange={event => onGitNameChange(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-4 py-3 text-foreground focus:border-transparent focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            placeholder="John Doe"
            required
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-muted-foreground">Saved as `git config --global user.name`.</p>
        </div>

        <div>
          <label htmlFor="gitEmail" className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <Mail className="h-4 w-4" />
            Git Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            id="gitEmail"
            value={gitEmail}
            onChange={event => onGitEmailChange(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-4 py-3 text-foreground focus:border-transparent focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            placeholder="john@example.com"
            required
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-muted-foreground">Saved as `git config --global user.email`.</p>
        </div>
      </div>
    </div>
  );
}
