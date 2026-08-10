import { Navigate, Route, Routes } from 'react-router-dom'
import { CommandPalette } from './components/CommandPalette'
import { HandoffListener } from './components/HandoffListener'
import { Shortcuts } from './components/Shortcuts'
import { Spinner } from './components/primitives'
import { HistoryPage } from './pages/HistoryPage'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { ModuleView } from './pages/ModuleView'
import { ProjectDashboard } from './pages/ProjectDashboard'
import { ProjectShell } from './pages/ProjectShell'
import { ReplayView } from './pages/ReplayView'
import { SessionView } from './pages/SessionView'
import { SharedView } from './pages/SharedView'
import { useAuth } from './state/auth'

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/shared/:token" element={<SharedView />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/replay/:sessionId" element={<ReplayView />} />
        <Route path="/shared/:token" element={<SharedView />} />
        <Route path="/p/:projectId" element={<ProjectShell />}>
          <Route index element={<ProjectDashboard />} />
          <Route path="m/:moduleId" element={<ModuleView />} />
          <Route path="s/:sessionId" element={<SessionView />} />
          <Route path="history" element={<HistoryPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CommandPalette />
      <Shortcuts />
      <HandoffListener />
    </>
  )
}
