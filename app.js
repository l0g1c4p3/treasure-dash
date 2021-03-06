const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const rooms = [];
const PLAYERS_PER_GAME = 2;
const MAX_ROLL = 6;
const WARM_DISTANCE = 1;

app.get('/', function(req, res) {
  res.sendFile(__dirname + '/views/index.html');
});

app.use(express.static('static'));

io.on('connection', function(socket) {
  console.log('user connected:' + socket.id);
  findRoom(socket);

  socket.on('startPos', function(coordinates) {
    const socketRoom = getSocketRoom(socket);

    const socketRoomUser = getSocketRoomUser(socketRoom, socket.id);

    socketRoomUser.pos = coordinates;
    emitPositionUpdates(socketRoomUser, coordinates);

    const allUsersHaveSelectedStartPos = socketRoom.users.every((user) => {
      return user['pos'] != null;
    });

    if (socketRoom.users.length == PLAYERS_PER_GAME && allUsersHaveSelectedStartPos) {
      // randomly choose player to go first
      const randomIndex = generateRandomNumber(PLAYERS_PER_GAME);
      const playerTurn = socketRoom.users[randomIndex];
      socketRoom.playerTurn = playerTurn.id;

      io.in(socketRoom.name).emit('gameStart');
      io.in(socketRoom.name).emit('logMsg', 'The game is now live!');
      
      rollDice(socketRoom, socket);
      const activePlayerSocket = getSocketFromID(socketRoom.playerTurn);    

      activePlayerSocket.emit('msg', 'You have been chosen to go first!');
      activePlayerSocket.broadcast.emit('msg', 'Your opponent has been chosen to go first.');
      activePlayerSocket.emit('activePlayer');
      activePlayerSocket.broadcast.emit('activeOpponent');
    } else if (socketRoom.users.length == PLAYERS_PER_GAME) {
      socket.emit('msg', 'Waiting for your opponent to pick a starting position.')
    }
  });

  socket.on('clientDig', function(coordinates) {
    const socketRoom = getSocketRoom(socket);
    
    // check if it's their turn
    if (socketRoom.playerTurn === socket.id) {
      const socketRoomUser = getSocketRoomUser(socketRoom, socket.id);

      // check move is in range
      const isValidMove = getIsValidMove(socketRoomUser.pos, coordinates, socketRoomUser.roll)
      if (isValidMove) {
        // update their position
        socketRoomUser.pos = coordinates;
  
        const closeness = getCloseness(socketRoom, coordinates); 
  
        if (closeness === 'success') {
          io.to(socketRoom.name).emit('playerWin', {'winner' : socket.id, 'coordinates' : coordinates, 'closeness': closeness});
        } else {
          io.to(socketRoom.name).emit('serverDig', {'coordinates' : coordinates, 'closeness': closeness});
        }
        emitPositionUpdates(socketRoomUser, coordinates);
        
        // only send closeness to the player
        socket.emit('closenessMsg', {'closeness': closeness});
  
        switchPlayerTurn(socketRoom);
        updateTurnText(socket, socketRoom);
        rollDice(socketRoom, socket);
      } else {
        // invalid move
        const msgText = `Invalid move! You only rolled a ${socketRoomUser.roll}.`;
        socket.emit('msg', msgText);
      }

    } else {
      if (socketRoom.users.length == PLAYERS_PER_GAME) {
        socket.emit('msg', 'Wait for your turn!');
      }
    }
  });

  socket.on('disconnect', function() {
    // remove player from room users
    const socketRoom = getSocketRoom(socket);
    const socketIndex = socketRoom.users.indexOf(socketRoom);
  
    socketRoom.users.splice(socketIndex, 1);
  
    // emit msg to that room to notify other player
    socket.broadcast.to(socketRoom.name).emit('msg', `Player ${socket.id} has left the room.`);
  });
});

function findRoom(socket) {
  let roomFound = false;
  // loop through the rooms looking for a slot
  rooms.forEach(room => {
    if (room.users.length < 2) {
      joinRoom(socket, room);
      roomFound = true;
    }
  });

  if (!roomFound) {
    // create a new room
    const roomName = 'room' + (rooms.length + 1);
    rooms.push({
      'name': roomName,
      'users': []
    });

    joinRoom(socket, rooms[rooms.length - 1]);
  }
}

function joinRoom(socket, room) {
  const newUser = {
    id: socket.id,
    pos: null
  }
  room.users.push(newUser); // add user to that room
  socket.join(room.name);

  // send message to the client
  socket.emit('logMsg', `You have joined '${room.name}`);
  socket.emit('logMsg', `Your ID is ${socket.id}`);

  // send message to the room
  io.in(room.name).emit('logMsg', `Player ${socket.id} has joined the room.`);

  if (room.users.length === PLAYERS_PER_GAME) {
    setTreasureCoordinates(room);

    io.in(room.name).emit('msg', 'Select a starting position.');
  } else {
    socket.emit('msg', 'Waiting for an opponent...');
  }
}

function getSocketRoom(socket) {
  let socketRoom;
  rooms.forEach(room => {
    const user = room.users.filter(function(user){ 
      return user.id === socket.id;
    });

    if (user) {
      socketRoom = room;
    }
  });

  return socketRoom;
}

function setTreasureCoordinates(room) {
  const rowCount = 10;
  const colCount = 10;

  let treasureRow = generateRandomNumber(rowCount);
  treasureRow++;
  let treasureCol = generateRandomNumber(colCount);
  treasureCol++;

  room.treasureCoordinates = {'row': treasureRow, 'col': treasureCol};
  console.log('treasureCoordinates: ', room.treasureCoordinates);
}

function getCloseness(room, coordinates) {
  const treasureRow = room.treasureCoordinates.row;
  const treasureCol = room.treasureCoordinates.col;

  const rowClose = inRange(coordinates.row, treasureRow - WARM_DISTANCE, treasureRow + WARM_DISTANCE);
  const colClose = inRange(coordinates.col, treasureCol - WARM_DISTANCE, treasureCol + WARM_DISTANCE);

  if (coordinates.row == treasureRow && coordinates.col == treasureCol) {
    return 'success';
  } else if (rowClose && colClose) {
    return 'warm';
  } else {
    return 'cold';
  }
}

function inRange(value, min, max) {
  if (value >= min && value <= max) {
    return true;
  }

  return false;
}

function switchPlayerTurn(socketRoom) {
  const playerTurn = getInactivePlayer(socketRoom);
  socketRoom.playerTurn = playerTurn.id;

  const activePlayerSocket = getSocketFromID(playerTurn.id);
  activePlayerSocket.emit('activePlayer');
  activePlayerSocket.broadcast.emit('activeOpponent');
}

/**
 * Get the player who's turn it isn't
 * @param {*} socketRoom 
 */
function getInactivePlayer(socketRoom) {
  const currentPlayerIndex = socketRoom.users.findIndex(function(user) {
    return user.id === socketRoom.playerTurn
  })
  const otherPlayerID = socketRoom.users[(currentPlayerIndex + 1) % socketRoom.users.length];

  return otherPlayerID;
}

function updateTurnText(socket, socketRoom) {
  if (socketRoom.playerTurn === socket.id) {
    socket.emit('msg', 'It\'s your turn!');    
    socket.broadcast.emit('msg', 'It\'s your opponent\'s turn.');    
  } else {
    socket.emit('msg', 'It\'s your opponent\'s turn.');
    socket.broadcast.emit('msg', 'It\'s your turn!');    
  }
}

function generateRandomNumber(range) {
  const random = Math.floor(Math.random() * Math.floor(range));
  return random;
}

function getSocketRoomUser(socketRoom, socketID) {
  const socketRoomUser = socketRoom.users.filter(function(user) {
    return user.id === socketID;
  });

  return socketRoomUser[0];
}

function rollDice(socketRoom, socket) {
  const activePlayerID = socketRoom.playerTurn;
  const roll = generateRandomNumber(MAX_ROLL);
  const socketRoomUser = getSocketRoomUser(socketRoom, activePlayerID)
  socketRoomUser.roll = roll + 1;

  activePlayerSocket = getSocketFromID(activePlayerID);
  activePlayerSocket.emit('logMsg', `You rolled a ${socketRoomUser.roll}`);
  activePlayerSocket.broadcast.emit('logMsg', `Your opponent rolled a ${socketRoomUser.roll}`)
  activePlayerSocket.emit('roll', {roll: socketRoomUser.roll, isOpponentRoll: false});
  activePlayerSocket.broadcast.emit('roll', {roll: socketRoomUser.roll, isOpponentRoll: true});
}

function getSocketFromID(socketID)
{
  const socket = io.sockets.sockets[socketID];
  return socket;
}

function getIsValidMove(currentPos, newPos, roll) {
  if (newPos.col === currentPos.col) {
    if (newPos.row <= (currentPos.row + roll) 
    && newPos.row >= (currentPos.row - roll)) {
      return true;
    }
  }

  if (newPos.row === currentPos.row) {
    if (newPos.col <= (currentPos.col + roll)
    && newPos.col >= (currentPos.col - roll)) {
      return true;
    }
  }

  return false;
}

function emitPositionUpdates(socketRoomUser, coordinates) {
  const activeSocket = getSocketFromID(socketRoomUser.id);
  activeSocket.emit('updatePlayerPosition', {'coordinates' : coordinates, 'isOpponentMove': false});
  activeSocket.broadcast.emit('updatePlayerPosition', {'coordinates' : coordinates, 'isOpponentMove': true});
}

http.listen(3000, function() {
  console.log('listening on *:3000');
});