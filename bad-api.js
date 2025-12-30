const express = require('express');
const app = express()
const port = 3000;

app.use(express.json())

let tasks = [
  {id: 1, title: "Buy milk", done: false},
  {id: 2, title: "Walk dog", done: true}
];

app.get('/tasks', (req, res) => {
  res.send(tasks)
})

app.get('/tasks/:id', (req,res)=>{
  const id = req.params.id
  for(let i=0;i<tasks.length;i++){
    if(tasks[i].id == id){
      res.json(tasks[i])
      return
    }
  }
  res.status(404).send('Task not found')
});

app.post('/tasks', (req, res) => {
  const newTask = req.body;
  newTask.id = tasks.length + 1
  tasks.push(newTask)
  res.send(newTask)
})

app.put('/tasks/:id', (req,res) => {
  let id = req.params.id
  let updated = req.body
  let found = false
  tasks.forEach(task => {
    if(task.id == id){
      task.title = updated.title
      task.done = updated.done
      found = true
    }
  })
  if(found){
    res.send('Updated')
  } else {
    res.status(404).send('Not found')
  }
})

app.delete('/tasks/:id',(req,res)=>{
  const id = req.params.id;
  tasks = tasks.filter(t => t.id != id);
  res.send('Deleted')
})

app.listen(port, () => {
  console.log('Server running on port'+port)
})
