import { Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import Dashboard from '@/routes/Dashboard'
import Receipt from '@/routes/Receipt'
import Catalog from '@/routes/Catalog'
import History from '@/routes/History'
import Settings from '@/routes/Settings'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/receipts/:id" element={<Receipt />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/history" element={<History />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
